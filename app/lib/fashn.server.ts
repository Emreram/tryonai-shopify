// FASHN Virtual Try-On v1.6 provider (PILOT — runs behind a flag / in shadow mode; NOT wired live).
//
// Mirrors the generateTryOn() contract from app/lib/openai.server.ts so it can be swapped/benchmarked.
//
// ── Verified against the live FASHN docs on 2026-06-01 ───────────────────────────────────────────
// Docs:    https://docs.fashn.ai/api-reference/tryon-v1-6
//          https://docs.fashn.ai/api-overview/api-fundamentals  (async run/status workflow)
//          https://docs.fashn.ai/api-overview/error-handling     (failed-status shape)
//          https://help.fashn.ai/plans-and-pricing/api-pricing   (per-image price)
//
// Base URL:   https://api.fashn.ai
// Auth:       Authorization: Bearer <FASHN_API_KEY>
//
// Submit (async):  POST https://api.fashn.ai/v1/run
//   Body:
//     {
//       "model_name": "tryon-v1.6",
//       "inputs": {
//         "model_image":   "<URL or data:image/...;base64,...>",   // the PERSON
//         "garment_image": "<URL or data:image/...;base64,...>",   // the GARMENT
//         "category":          "auto" | "tops" | "bottoms" | "one-pieces",      // default "auto"
//         "segmentation_free": boolean,                                          // default true
//         "moderation_level":  "conservative" | "permissive" | "none",          // default "permissive"
//         "garment_photo_type":"auto" | "flat-lay" | "model",                   // default "auto"
//         "mode":              "performance" | "balanced" | "quality",          // default "balanced"
//         "seed":              integer 0..2^32-1,                                // default 42
//         "num_samples":       integer 1..4,                                     // default 1
//         "output_format":     "png" | "jpeg",                                   // default "png"
//         "return_base64":     boolean                                           // default false
//       }
//     }
//   Initial response:  { "id": "<prediction-id>", "error": null }
//   Base64 images MUST include the data-URI prefix, e.g. "data:image/jpeg;base64,<...>".
//
// Poll:   GET https://api.fashn.ai/v1/status/{id}
//   status ∈ "starting" | "in_queue" | "processing" | "completed" | "failed"
//   completed: { "id": "...", "status": "completed", "output": ["https://cdn.fashn.ai/.../output_0.png"], "error": null }
//   failed:    { "id": "...", "status": "failed", "error": { "name": "ImageLoadError", "message": "..." } }
//   Note: a failed prediction still returns HTTP 200 — inspect the body, not just the status code.
//
// Limits / timing (from docs, 2026-06-01):
//   - CDN output URLs valid 72h; base64 outputs valid 60min.
//   - /v1/run rate limit 50 req / 60s; /v1/status rate limit 50 req / 10s; max 6 concurrent.
//   - Processing ~5s (performance) to ~12-17s (quality). We bound total wait at ~120s.
//   - Response header x-fashn-credits-used reports credits consumed per prediction.
//
// Pricing (https://help.fashn.ai/plans-and-pricing/api-pricing, 2026-06-01):
//   tryon-v1.6 = 1 credit per output image; on-demand pricing starts at ~$0.075/image
//   (drops below ~$0.04 at volume). We use the flat on-demand $0.075 as the pilot cost estimate.
//   Failed predictions do not consume credits.
//
// ── Caveats ──────────────────────────────────────────────────────────────────────────────────────
// - We send inline base64 data URIs (no upload step needed). For very large images this inflates the
//   request body; callers may instead pass selfieUrl/garmentUrl to skip base64 entirely (see input ext).
// - We do NOT emit "preview"/"partial" events: FASHN is a single async job with no progressive frames,
//   so generateTryOnFashn() yields only a single { kind: "completed" } event. The reveal-animation UX
//   that openai.server.ts gets from the low+medium dual pass is not available here.
// - We do NOT emit a "timing" event from the generator: that event carries TryOnOpenAITiming (real
//   OpenAI usage tokens) and fabricating one would pollute UsageLog.costUsd with fake OpenAI numbers.
//   FASHN benchmark timing/cost is exposed separately via generateTryOnFashnWithTiming().

import type { TryOnInput, TryOnStreamEvent } from "./openai.server";

/** Exact model id from https://docs.fashn.ai/api-reference/tryon-v1-6 (verified 2026-06-01). */
export const FASHN_TRYON_MODEL = "tryon-v1.6" as const;

const FASHN_BASE_URL = "https://api.fashn.ai";
const FASHN_RUN_URL = `${FASHN_BASE_URL}/v1/run`;
const FASHN_STATUS_URL = (id: string) => `${FASHN_BASE_URL}/v1/status/${id}`;

// On-demand per-image price for tryon-v1.6 (1 credit), verified 2026-06-01 at
// https://help.fashn.ai/plans-and-pricing/api-pricing ("starts at $0.075 per image").
const FASHN_TRYON_PRICE_USD = 0.075;

const TOTAL_TIMEOUT_MS = 120_000;
const INITIAL_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 2_000;
const POLL_BACKOFF_FACTOR = 1.25;

export type FashnMode = "performance" | "balanced" | "quality";

export type FashnTryOnInput = TryOnInput & {
  /** Override the FASHN generation mode. Defaults to "balanced". */
  mode?: FashnMode;
  /**
   * Optional: pass an already-hosted image URL instead of inlining the Buffer as base64.
   * If provided, it takes precedence over the corresponding Buffer.
   */
  selfieUrl?: string;
  garmentUrl?: string;
};

export interface FashnTimings {
  /** ms (performance.now) when the /v1/run submit returned. */
  tSubmit: number;
  /** ms when the first /v1/status poll returned. */
  tFirstPoll: number | null;
  /** ms when status === "completed" was observed. */
  tCompleted: number | null;
  /** number of /v1/status requests issued. */
  pollCount: number;
}

export interface FashnResult {
  b64: string;
  timings: FashnTimings;
  costUsd: number;
  predictionId: string;
  /** Value of the x-fashn-credits-used response header, if present. */
  creditsUsed: number | null;
}

/**
 * Per-image USD cost for a tryon-v1.6 generation.
 * @param numSamples number of output images requested (default 1). FASHN bills 1 credit per output.
 */
export function computeFashnCostUsd(numSamples = 1): number {
  const n = Number.isFinite(numSamples) && numSamples > 0 ? numSamples : 1;
  return FASHN_TRYON_PRICE_USD * n;
}

/**
 * Minimal generator mirroring generateTryOn(): yields only a single completed JPEG.
 * FASHN exposes no progressive frames, so there are no "partial"/"preview" events,
 * and no "timing" event (that would carry fake OpenAI usage). Use
 * generateTryOnFashnWithTiming() when you need timings/cost for the benchmark harness.
 */
export async function* generateTryOnFashn(
  input: FashnTryOnInput,
): AsyncGenerator<TryOnStreamEvent, void, void> {
  const { b64 } = await runFashnTryOn(input);
  yield { kind: "completed", b64 };
}

/**
 * Benchmark-harness entry point. Same generation as generateTryOnFashn() but returns the
 * final base64 JPEG plus submit/poll/completed timings, poll count, the prediction id,
 * credits used (from the x-fashn-credits-used header), and the estimated costUsd.
 */
export async function generateTryOnFashnWithTiming(
  input: FashnTryOnInput,
): Promise<FashnResult> {
  return runFashnTryOn(input);
}

async function runFashnTryOn(input: FashnTryOnInput): Promise<FashnResult> {
  const apiKey = process.env.FASHN_API_KEY;
  if (!apiKey) {
    throw new Error("FASHN_API_KEY is not set");
  }

  const { signal } = input;
  throwIfAborted(signal);

  const mode: FashnMode = input.mode ?? "balanced";
  const numSamples = 1;

  const modelImage = input.selfieUrl ?? toDataUri(input.selfie, input.selfieMimeType, "selfie");
  const garmentImage =
    input.garmentUrl ?? toDataUri(input.garment, input.garmentMimeType, "garment");

  const inputs: Record<string, unknown> = {
    model_image: modelImage,
    garment_image: garmentImage,
    category: "auto",
    mode,
    num_samples: numSamples,
    output_format: "jpeg",
    return_base64: false,
  };
  // NOTE: FASHN tryon-v1.6 has no free-text prompt field, so input.prompt is intentionally
  // NOT forwarded. Behavior is controlled via `mode`/`category` instead. (Documented so the
  // dropped field is explicit and not a silent omission.)

  const timings: FashnTimings = {
    tSubmit: 0,
    tFirstPoll: null,
    tCompleted: null,
    pollCount: 0,
  };

  // ── Submit ───────────────────────────────────────────────────────────────────────────────────
  const submitRes = await fetchFashn(
    FASHN_RUN_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model_name: FASHN_TRYON_MODEL, inputs }),
      signal,
    },
    "submit",
  );

  timings.tSubmit = performance.now();

  // Read the HTTP status BEFORE strictly parsing JSON: a 401/429/5xx from /v1/run
  // can carry a non-JSON body, which must not be reported as an "invalid JSON" error.
  if (!submitRes.ok) {
    const errBody = await readJsonSafe(submitRes);
    const message =
      stringifyError((errBody as { error?: unknown } | null)?.error) ??
      `FASHN /v1/run returned HTTP ${submitRes.status}`;
    fashnError({ stage: "submit", status: submitRes.status, message });
    throw new Error(`FASHN submit failed: ${message}`);
  }

  const submitBody = (await readJson(submitRes, "submit")) as {
    id?: string;
    error?: unknown;
  };

  if (submitBody.error || !submitBody.id) {
    const message =
      stringifyError(submitBody.error) ??
      `FASHN /v1/run returned HTTP ${submitRes.status} without a prediction id`;
    fashnError({ stage: "submit", status: submitRes.status, message });
    throw new Error(`FASHN submit failed: ${message}`);
  }

  const predictionId = submitBody.id;
  const creditsUsedHeader = parseCredits(submitRes.headers.get("x-fashn-credits-used"));

  // ── Poll ─────────────────────────────────────────────────────────────────────────────────────
  const deadline = performance.now() + TOTAL_TIMEOUT_MS;
  let interval = INITIAL_POLL_INTERVAL_MS;
  let creditsUsed = creditsUsedHeader;
  let outputUrl: string | null = null;

  while (performance.now() < deadline) {
    throwIfAborted(signal);
    await sleep(interval, signal);
    throwIfAborted(signal);

    const statusRes = await fetchFashn(
      FASHN_STATUS_URL(predictionId),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      },
      "poll",
    );
    timings.pollCount += 1;
    if (timings.tFirstPoll === null) timings.tFirstPoll = performance.now();

    const statusCredits = parseCredits(statusRes.headers.get("x-fashn-credits-used"));
    if (statusCredits !== null) creditsUsed = statusCredits;

    // Read the HTTP status BEFORE attempting to parse JSON: auth (401), rate-limit
    // (429), and gateway (5xx) responses frequently carry a non-JSON body, and we
    // must surface the real status instead of masking it as an "invalid JSON" error.
    if (!statusRes.ok) {
      const errBody = await readJsonSafe(statusRes);
      const message =
        stringifyError((errBody as { error?: unknown } | null)?.error) ??
        `HTTP ${statusRes.status} from /v1/status`;
      fashnError({ stage: "poll", predictionId, status: statusRes.status, message });
      throw new Error(`FASHN status poll failed: ${message}`);
    }

    const statusBody = (await readJson(statusRes, "poll")) as {
      id?: string;
      status?: string;
      output?: unknown;
      error?: unknown;
    };

    const status = statusBody.status;

    if (status === "completed") {
      timings.tCompleted = performance.now();
      outputUrl = firstOutputUrl(statusBody.output);
      if (!outputUrl) {
        fashnError({
          stage: "poll",
          predictionId,
          message: "completed status but no output URL in response",
        });
        throw new Error(`FASHN completed without an output image (prediction ${predictionId})`);
      }
      break;
    }

    if (status === "failed") {
      const message = stringifyError(statusBody.error) ?? "unknown failure";
      fashnError({ stage: "poll", predictionId, status: "failed", message });
      throw new Error(`FASHN try-on failed: ${message} (prediction ${predictionId})`);
    }

    // starting | in_queue | processing | (unknown) -> keep polling with light backoff.
    interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), MAX_POLL_INTERVAL_MS);
  }

  if (!outputUrl) {
    fashnError({
      stage: "poll",
      predictionId,
      message: `Timed out after ${TOTAL_TIMEOUT_MS}ms (${timings.pollCount} polls)`,
    });
    throw new Error(
      `FASHN try-on timed out after ${TOTAL_TIMEOUT_MS}ms (prediction ${predictionId})`,
    );
  }

  // ── Fetch the output image and convert to base64 JPEG ──────────────────────────────────────────
  const b64 = await fetchImageAsBase64(outputUrl, signal, predictionId);

  return {
    b64,
    timings,
    costUsd: computeFashnCostUsd(numSamples),
    predictionId,
    creditsUsed,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Encode a Buffer as a FASHN-compatible data URI (prefix is required by the API). */
function toDataUri(buffer: Buffer, mimeType: string, name: string): string {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported ${name} image type for FASHN: ${mimeType}`);
  }
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function firstOutputUrl(output: unknown): string | null {
  if (Array.isArray(output) && output.length > 0 && typeof output[0] === "string") {
    return output[0];
  }
  return null;
}

async function fetchImageAsBase64(
  url: string,
  signal: AbortSignal | undefined,
  predictionId: string,
): Promise<string> {
  const res = await fetchFashn(url, { method: "GET", signal }, "download");
  if (!res.ok) {
    fashnError({
      stage: "download",
      predictionId,
      status: res.status,
      message: `failed to download output image`,
    });
    throw new Error(
      `FASHN output download failed: HTTP ${res.status} (prediction ${predictionId})`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

async function fetchFashn(
  url: string,
  init: RequestInit,
  stage: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = getErrorMessage(err);
    fashnError({ stage, message });
    throw new Error(`FASHN ${stage} request failed: ${message}`);
  }
}

async function readJson(res: Response, stage: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    const message = getErrorMessage(err);
    fashnError({ stage, status: res.status, message: `invalid JSON: ${message}` });
    throw new Error(`FASHN ${stage} returned invalid JSON (HTTP ${res.status})`);
  }
}

/** Best-effort JSON parse for error responses; returns null if the body isn't JSON. */
async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseCredits(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function stringifyError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown };
    const name = typeof e.name === "string" ? e.name : null;
    const message = typeof e.message === "string" ? e.message : null;
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
  }
  return JSON.stringify(error);
}

function fashnError(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: "fashn_error", ...fields }));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
