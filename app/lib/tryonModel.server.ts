// Try-on image generation: OpenAI's gpt-image-2, reached through OpenRouter's
// Image API (`POST /api/v1/images`). See openrouter.server.ts for the transport,
// credentials, and error taxonomy.
//
// A try-on is exactly ONE image request. It used to be two — a throwaway
// quality:"low" pass racing the real one — but image models are rate-limited by
// IMAGES per minute, so the second pass halved effective throughput. It bought
// nothing: the storefront never painted the preview pixels, it only used their
// arrival time to nudge a progress bar, and the `partial_images` frames on this
// single pass already provide that signal plus the same last-known-good bytes
// the client falls back to when a stream dies early.

import {
  ModelError,
  OPENROUTER_IMAGES_URL,
  TRYON_IMAGE_MODEL,
  modelErrorFromResponse,
  openRouterHeaders,
} from "./openrouter.server";

export { TRYON_IMAGE_MODEL };

export interface GarmentInput {
  buffer: Buffer;
  mimeType: string;
  /** e.g. "top", "trousers", "shoes" — used to build the multi-garment prompt. */
  label?: string;
}

export type TryOnQuality = "low" | "medium" | "high";
export type TryOnSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface TryOnInput {
  selfie: Buffer;
  selfieMimeType: string;
  garment: Buffer;
  garmentMimeType: string;
  /**
   * Extra garments for an OUTFIT try-on (the Stylist). When present, all garments
   * are composited onto the person in one generation and an outfit prompt is used.
   */
  additionalGarments?: GarmentInput[];
  /** Slot labels aligned to [garment, ...additionalGarments] for the prompt. */
  garmentLabels?: string[];
  prompt?: string;
  quality?: TryOnQuality;
  size?: TryOnSize;
  signal?: AbortSignal;
  /** Opaque, privacy-preserving end-user identifier for abuse monitoring. */
  user?: string;
}

/**
 * Usage as reported by OpenRouter's image completion event. `cost` is the
 * authoritative USD charge for the render — we no longer reconstruct it from
 * per-token rate tables, which is what previously let a stale rate silently
 * skew every UsageLog row and trip the daily spend fuse early.
 */
export interface TryOnUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
}

export interface TryOnTiming {
  model: string;
  quality: TryOnQuality;
  aspectRatio: string;
  /** OpenRouter's request id, from the `x-request-id` response header. */
  requestId: string | null;
  usage: TryOnUsage | null;
  /** `image/jpeg`, `image/png`, … as reported by the completed event. */
  mediaType: string | null;
  tStart: number;
  tFirstEvent: number | null;
  tCompleted: number | null;
  error: string | null;
}

export type TryOnStreamEvent =
  | { kind: "completed"; b64: string; mediaType: string | null }
  | { kind: "timing"; openai: TryOnTiming };

/**
 * The Image API has no `size` parameter — output dimensions come from
 * `aspect_ratio`, whose allowed values for the gpt-image-2 endpoint are
 * 1:1 | 3:2 | 2:3 | 4:3 | 3:4 | 16:9 | 9:16 | 21:9 | auto.
 */
const ASPECT_RATIO_BY_SIZE: Record<TryOnSize, string> = {
  "1024x1024": "1:1",
  "1024x1536": "2:3",
  "1536x1024": "3:2",
};

const DEFAULT_PROMPT =
  "Photorealistic full-body editorial photograph: the person from the first image wearing the garment from the second image. Preserve the person's face, hair, skin tone, body proportions, and pose exactly. Keep the original background and lighting from the first image - do not invent a new scene. Fit the garment naturally with realistic fabric drape, wrinkles, and shadows that match the existing lighting direction. Match the garment's color, pattern, logos, stitching, and texture from the reference image precisely. No text, no watermarks. Studio-quality fashion editorial finish.";

// Builds the prompt for a COMBINED outfit try-on, where images 2..N are separate
// garments to be worn together. Labels (top/trousers/shoes…) align to images 2..N.
export function buildOutfitPrompt(labels?: string[]): string {
  const refs =
    labels && labels.length > 0
      ? labels.map((l, i) => `the ${l} from image ${i + 2}`).join(", ")
      : "every garment from images 2 onward";
  return (
    "Photorealistic full-body editorial photograph: the person from image 1 wearing " +
    `this complete outfit together — ${refs}. Dress them in ALL of these garments at ` +
    "once, layered correctly and naturally (tops tucked or untucked sensibly, bottoms " +
    "below tops, shoes on the feet). Preserve the person's face, hair, skin tone, body " +
    "proportions, and pose exactly. Keep the original background and lighting from image 1 " +
    "- do not invent a new scene. Match each garment's color, pattern, logos, stitching, " +
    "and texture precisely from its own reference image. Realistic fabric drape, wrinkles, " +
    "and shadows consistent with the lighting. No text, no watermarks. Studio-quality " +
    "fashion editorial finish."
  );
}

export async function* generateTryOn({
  selfie,
  selfieMimeType,
  garment,
  garmentMimeType,
  additionalGarments,
  garmentLabels,
  prompt,
  quality = "medium",
  size = "1024x1536",
  signal,
  user,
}: TryOnInput): AsyncGenerator<TryOnStreamEvent, void, void> {
  const garments: GarmentInput[] = [
    { buffer: garment, mimeType: garmentMimeType },
    ...(additionalGarments ?? []),
  ];
  // reference[0] = person; reference[1..N] = garment(s). Single-garment is N=1.
  const references = [
    { buffer: selfie, mimeType: selfieMimeType },
    ...garments,
  ];
  const effectivePrompt =
    prompt ?? (garments.length > 1 ? buildOutfitPrompt(garmentLabels) : DEFAULT_PROMPT);

  const timing = createTiming(quality, size);

  try {
    const image = await requestImage({
      prompt: effectivePrompt,
      references,
      size,
      quality,
      signal,
      timing,
      user,
    });
    yield { kind: "completed", b64: image.b64, mediaType: image.mediaType };
    yield { kind: "timing", openai: timing };
  } catch (err) {
    timing.error = err instanceof Error ? err.message : String(err);
    yield { kind: "timing", openai: timing };
    throw err;
  }
}

// ---- layered outfit try-on ("Refine fit") ----------------------------------
//
// Higher-fidelity alternative to the combined pass: dress the person one garment
// at a time, feeding each result back in as the base for the next. More reliable
// composition for 3-4 piece outfits, at ~N images of cost — and N images against
// an images-per-minute limit, so it is the most rate-limit-hungry path here.

export type OutfitLayeredEvent =
  | { kind: "layer"; index: number; total: number; b64: string }
  | { kind: "completed"; b64: string; mediaType: string | null }
  | { kind: "usage"; usages: Array<TryOnUsage | null>; elapsedMs: number }
  | { kind: "error"; error: unknown };

export async function* generateOutfitLayered({
  selfie,
  selfieMimeType,
  garments,
  size = "1024x1536",
  quality = "medium",
  signal,
  user,
}: {
  selfie: Buffer;
  selfieMimeType: string;
  garments: GarmentInput[];
  size?: "1024x1536" | "1536x1024";
  quality?: TryOnQuality;
  signal?: AbortSignal;
  user?: string;
}): AsyncGenerator<OutfitLayeredEvent, void, void> {
  if (garments.length === 0) throw new Error("generateOutfitLayered: no garments");

  let baseBuffer = selfie;
  let baseMime = selfieMimeType;
  const usages: Array<TryOnUsage | null> = [];
  const tStart = performance.now();

  try {
    for (let i = 0; i < garments.length; i++) {
      const garment = garments[i];
      const label = garment.label ?? "garment";
      const timing = createTiming(quality, size);
      const layerPrompt =
        "Photorealistic full-body photograph: keep the person, their face, body, " +
        "pose, and the background from image 1 exactly, and additionally put on the " +
        `${label} from image 2, fitted and layered naturally over what they already ` +
        `wear. Match the ${label}'s color, pattern, and texture precisely. Realistic ` +
        "drape and shadows. No text, no watermarks.";

      const image = await requestImage({
        prompt: layerPrompt,
        references: [
          { buffer: baseBuffer, mimeType: baseMime },
          { buffer: garment.buffer, mimeType: garment.mimeType },
        ],
        size,
        quality,
        signal,
        timing,
        user,
      });
      const { b64, mediaType } = image;

      usages.push(timing.usage);
      baseBuffer = Buffer.from(b64, "base64");
      baseMime = mediaType ?? "image/png";

      if (i < garments.length - 1) {
        yield { kind: "layer", index: i, total: garments.length, b64 };
      } else {
        yield { kind: "completed", b64, mediaType };
      }
    }
    yield {
      kind: "usage",
      usages,
      elapsedMs: Math.round(performance.now() - tStart),
    };
  } catch (err) {
    yield { kind: "error", error: err };
  }
}

// ---- OpenRouter Image API call ---------------------------------------------

function createTiming(quality: TryOnQuality, size: TryOnSize): TryOnTiming {
  return {
    model: TRYON_IMAGE_MODEL,
    quality,
    aspectRatio: ASPECT_RATIO_BY_SIZE[size],
    requestId: null,
    usage: null,
    mediaType: null,
    tStart: performance.now(),
    tFirstEvent: null,
    tCompleted: null,
    error: null,
  };
}

export interface RenderedImage {
  b64: string;
  mediaType: string | null;
  usage: TryOnUsage | null;
}

/**
 * One `POST /api/v1/images` call, returning the finished image.
 *
 * NOT streamed, and that is a hard constraint rather than a choice: OpenRouter
 * answers a request that carries `input_references` together with
 * `stream: true` with
 *   400 "Streaming is not supported for image-to-image (edit) requests".
 * Every try-on is image-to-image (the person, plus the garment), so there are no
 * partial frames to forward and the storefront progress bar runs entirely off
 * its scripted timeline. The Image API's documented streaming support applies to
 * text-to-image only.
 *
 * Mutates `timing` in place with the request id, usage, and phase marks so
 * callers can log a single COGS/latency record.
 */
async function requestImage({
  prompt,
  references,
  size,
  quality,
  signal,
  timing,
  user,
}: {
  prompt: string;
  references: Array<{ buffer: Buffer; mimeType: string }>;
  size: TryOnSize;
  quality: TryOnQuality;
  signal?: AbortSignal;
  timing: TryOnTiming;
  user?: string;
}): Promise<RenderedImage> {
  timing.tStart = performance.now();

  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: openRouterHeaders(),
    signal,
    body: JSON.stringify({
      model: TRYON_IMAGE_MODEL,
      prompt,
      n: 1,
      quality,
      aspect_ratio: ASPECT_RATIO_BY_SIZE[size],
      // JPEG at 85 keeps the SSE payload and the cached object roughly an order
      // of magnitude smaller than PNG at 1024x1536. `output_format` is not in
      // this endpoint's advertised parameter set, so a provider may ignore it —
      // the response reports the real `media_type`, which is propagated to the
      // client so the rendered data URL is correct either way.
      output_format: "jpeg",
      output_compression: 85,
      input_references: references.map((ref) => ({
        type: "image_url",
        image_url: {
          url: `data:${ref.mimeType};base64,${ref.buffer.toString("base64")}`,
        },
      })),
      ...(user ? { user } : {}),
    }),
  });

  timing.requestId = response.headers.get("x-request-id");

  if (!response.ok) {
    throw await modelErrorFromResponse(response);
  }

  const body: unknown = await response.json();
  timing.tFirstEvent = performance.now();

  // A 200 can still carry an error body: OpenRouter commits the HTTP status as
  // soon as a provider accepts the request, so provider-side failures (notably
  // OpenAI's safety system) arrive here rather than as a 4xx.
  const inlineError = await inlineErrorFrom(body, response.status);
  if (inlineError) throw inlineError;

  const image = readFirstImage(body);
  if (image === null) {
    throw new ModelError({
      kind: "upstream",
      status: response.status,
      message: "OpenRouter returned no image data",
    });
  }

  timing.tCompleted = performance.now();
  timing.mediaType = image.mediaType;
  timing.usage = readUsage(body);
  return { ...image, usage: timing.usage };
}

/** Detects an `{ error: … }` envelope returned with a 200 status. */
async function inlineErrorFrom(
  body: unknown,
  status: number,
): Promise<ModelError | null> {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return modelErrorFromResponse(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Reads `data[0]` from a buffered image response. */
function readFirstImage(body: unknown): { b64: string; mediaType: string | null } | null {
  if (typeof body !== "object" || body === null || !("data" in body)) return null;
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first: unknown = data[0];
  if (typeof first !== "object" || first === null || !("b64_json" in first)) {
    return null;
  }
  if (typeof first.b64_json !== "string" || first.b64_json.length === 0) return null;

  const mediaType =
    "media_type" in first && typeof first.media_type === "string"
      ? first.media_type
      : null;
  return { b64: first.b64_json, mediaType };
}

/** Reads the `usage` object off a completed-image payload; null when absent. */
function readUsage(payload: unknown): TryOnUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("usage" in payload)) return null;
  const usage = payload.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const num = (key: string): number | null => {
    const value: unknown = Reflect.get(usage, key);
    return typeof value === "number" ? value : null;
  };
  return {
    prompt_tokens: num("prompt_tokens"),
    completion_tokens: num("completion_tokens"),
    total_tokens: num("total_tokens"),
    cost: num("cost"),
  };
}
