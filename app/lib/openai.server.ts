import OpenAI, { toFile, APIError } from "openai";

export const OPENAI_TRYON_MODEL = "gpt-image-2-2026-04-21";

/**
 * Thrown when OpenAI's image-edit safety system rejects the request (almost
 * always the uploaded reference photo — the edit endpoint is intentionally
 * strict and refuses to edit photos it can't verify the caller owns, e.g.
 * multi-person/model-like shots). There is NO `moderation` param on
 * `images.edit` to relax this, so the only graceful response is a clear,
 * actionable message to the shopper. Carries the OpenAI request id for support.
 */
export class TryOnSafetyRejectionError extends Error {
  readonly code = "safety_rejected" as const;
  readonly openaiRequestId: string | null;
  readonly openaiCode: string | null;
  constructor(
    openaiRequestId: string | null,
    openaiCode: string | null,
    options?: { cause?: unknown },
  ) {
    super("OpenAI safety system rejected the try-on input image");
    this.name = "TryOnSafetyRejectionError";
    this.openaiRequestId = openaiRequestId;
    this.openaiCode = openaiCode;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const SAFETY_REJECTION_CODES = new Set([
  "moderation_blocked",
  "image_generation_user_error",
  "content_policy_violation",
]);

function isSafetyRejection(err: unknown): err is APIError {
  if (!(err instanceof APIError)) return false;
  if (err.status !== 400) return false;
  const code = String(err.code ?? "").toLowerCase();
  const type = String((err as { type?: unknown }).type ?? "").toLowerCase();
  const msg = String(err.message ?? "").toLowerCase();
  return (
    SAFETY_REJECTION_CODES.has(code) ||
    SAFETY_REJECTION_CODES.has(type) ||
    msg.includes("safety system") ||
    msg.includes("rejected by the safety")
  );
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    client = new OpenAI({ apiKey, timeout: 120_000 });
  }
  return client;
}

export interface TryOnInput {
  selfie: Buffer;
  selfieMimeType: string;
  garment: Buffer;
  garmentMimeType: string;
  prompt?: string;
  quality?: "low" | "medium" | "high";
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  signal?: AbortSignal;
  /** Opaque, privacy-preserving end-user identifier for OpenAI safety monitoring. */
  user?: string;
}

type TryOnQuality = "low" | "medium" | "high";

export interface TryOnUsageTokenDetails {
  text_tokens?: number;
  image_tokens?: number;
}

export interface TryOnUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: TryOnUsageTokenDetails | null;
  output_tokens_details?: TryOnUsageTokenDetails | null;
}

// gpt-image-2 pricing per million tokens (verify against https://openai.com/api/pricing/ before deploy).
// These rates feed UsageLog.costUsd, which drives empirical cost validation after first 1k generations
// and any plan-price decision before App Store listing.
const GPT_IMAGE_2_RATES = {
  inputImagePerToken: 10 / 1_000_000,
  inputTextPerToken: 5 / 1_000_000,
  outputImagePerToken: 40 / 1_000_000,
} as const;

export function computeCostUsd(usage: TryOnUsage | null | undefined): number {
  if (!usage) return 0;
  const inputImage = usage.input_tokens_details?.image_tokens ?? 0;
  const inputText = usage.input_tokens_details?.text_tokens ?? 0;
  const outputImage = usage.output_tokens ?? 0;
  return (
    inputImage * GPT_IMAGE_2_RATES.inputImagePerToken +
    inputText * GPT_IMAGE_2_RATES.inputTextPerToken +
    outputImage * GPT_IMAGE_2_RATES.outputImagePerToken
  );
}

export interface TryOnPassTiming {
  quality: TryOnQuality;
  size: string;
  requestId: string | null;
  processingMs: number | null;
  dateHeader: string | null;
  usage: TryOnUsage | null;
  tOpenaiStart: number;
  tFirstEvent: number | null;
  tFirstPartial: number | null;
  tCompleted: number | null;
  error: string | null;
}

export interface TryOnOpenAITiming {
  requestId: string | null;
  processingMs: number | null;
  dateHeader: string | null;
  usage: TryOnUsage | null;
  tOpenaiStart: number;
  tFirstEvent: number | null;
  tFirstPartial: number | null;
  tCompleted: number | null;
  tPreview: number | null;
  tFinalDelivered: number | null;
  previewSource: "low" | null;
  fallbackToPreview: boolean;
  warning: string | null;
  low: TryOnPassTiming;
  medium: TryOnPassTiming;
}

export type TryOnStreamEvent =
  | { kind: "partial"; index: number; b64: string }
  | { kind: "preview"; b64: string }
  | { kind: "completed"; b64: string }
  | { kind: "timing"; openai: TryOnOpenAITiming };

const FILE_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
// The low preview pass (quality "low", 1024x1024) is far faster than the medium
// final pass (1024x1536), so it reliably finishes first WITHOUT a long head start.
// This sleep delays the FINAL image 1:1, so keep it just long enough to let the
// low pass register as the first reveal frame (clean low-res) ahead of medium's
// noisy first partial — not a full second. Overridable for tuning/benchmarks.
const PREVIEW_HEAD_START_MS = parseHeadStartMs(process.env.TRYON_PREVIEW_HEAD_START_MS, 250);

function parseHeadStartMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_PROMPT =
  "Photorealistic full-body editorial photograph: the person from the first image wearing the garment from the second image. Preserve the person's face, hair, skin tone, body proportions, and pose exactly. Keep the original background and lighting from the first image - do not invent a new scene. Fit the garment naturally with realistic fabric drape, wrinkles, and shadows that match the existing lighting direction. Match the garment's color, pattern, logos, stitching, and texture from the reference image precisely. No text, no watermarks. Studio-quality fashion editorial finish.";

export async function* generateTryOn({
  selfie,
  selfieMimeType,
  garment,
  garmentMimeType,
  prompt = DEFAULT_PROMPT,
  quality = "medium",
  size = "1024x1536",
  signal,
  user,
}: TryOnInput): AsyncGenerator<TryOnStreamEvent, void, void> {
  const openai = getClient();
  const [selfieFile, garmentFile] = await Promise.all([
    toImageFile(selfie, "selfie", selfieMimeType),
    toImageFile(garment, "garment", garmentMimeType),
  ]);

  const queue = new AsyncQueue<TryOnQueueItem>();
  const previewSize = previewSizeFor(size);
  const lowTiming = createPassTiming("low", previewSize);
  const mediumTiming = createPassTiming(quality, size);
  const lowAbort = new AbortController();
  const mediumAbort = new AbortController();
  const unlinkParentAbort = linkAbortSignal(signal, [lowAbort, mediumAbort]);

  let lowDone = false;
  let lowSucceeded = false;
  let lowB64: string | null = null;
  let mediumDone = false;
  let mediumSucceeded = false;
  let mediumError: string | null = null;
  let safetyRejection: TryOnSafetyRejectionError | null = null;
  let finalQueued = false;
  let timingQueued = false;
  let previewEmitted = false;
  let tPreview: number | null = null;
  let tFinalDelivered: number | null = null;
  let fallbackToPreview = false;
  let warning: string | null = null;

  const buildTiming = (): TryOnOpenAITiming => ({
    requestId: mediumTiming.requestId,
    processingMs: mediumTiming.processingMs,
    dateHeader: mediumTiming.dateHeader,
    usage: mediumTiming.usage,
    tOpenaiStart: mediumTiming.tOpenaiStart,
    tFirstEvent: mediumTiming.tFirstEvent,
    tFirstPartial: mediumTiming.tFirstPartial,
    tCompleted: tFinalDelivered,
    tPreview,
    tFinalDelivered,
    previewSource: previewEmitted ? "low" : null,
    fallbackToPreview,
    warning,
    low: lowTiming,
    medium: mediumTiming,
  });

  const queueTerminal = (fatalError?: unknown) => {
    if (timingQueued) return;
    timingQueued = true;
    queue.push({ kind: "timing", openai: buildTiming() });
    if (fatalError) queue.push({ kind: "fatal", error: fatalError });
    queue.close();
    unlinkParentAbort();
  };

  const emitPreview = (b64: string) => {
    if (previewEmitted || finalQueued) return;
    previewEmitted = true;
    tPreview = performance.now();
    queue.push({ kind: "preview", b64 });
  };

  const emitFinal = (b64: string, fallbackWarning?: string) => {
    if (finalQueued) return;
    finalQueued = true;
    tFinalDelivered = performance.now();
    if (fallbackWarning) {
      fallbackToPreview = true;
      warning = fallbackWarning;
    }
    if (!lowDone && !lowAbort.signal.aborted) lowAbort.abort();
    queue.push({ kind: "completed", b64 });
    queueTerminal();
  };

  const fallbackOrFatalAfterMediumFailure = () => {
    if (!mediumDone || mediumSucceeded || finalQueued) return;
    if (lowSucceeded && lowB64) {
      emitFinal(
        lowB64,
        `Medium try-on failed; served low-quality preview as final. ${
          mediumError ?? ""
        }`.trim(),
      );
      return;
    }
    if (lowDone) {
      queueTerminal(
        safetyRejection ?? new Error(mediumError ?? "OpenAI medium try-on failed"),
      );
    }
  };

  void (async () => {
    try {
      lowB64 = await runImageEditPass({
        openai,
        image: [selfieFile, garmentFile],
        prompt,
        size: previewSize,
        quality: "low",
        partialImages: 0,
        signal: lowAbort.signal,
        timing: lowTiming,
        user,
      });
      lowSucceeded = true;
      emitPreview(lowB64);
    } catch (err) {
      if (err instanceof TryOnSafetyRejectionError) safetyRejection = err;
      if (!isAbortError(err) || (!finalQueued && !signal?.aborted)) {
        lowTiming.error = getErrorMessage(err);
      }
    } finally {
      lowDone = true;
      fallbackOrFatalAfterMediumFailure();
    }
  })();

  void (async () => {
    try {
      await sleep(PREVIEW_HEAD_START_MS, mediumAbort.signal);
      const b64 = await runImageEditPass({
        openai,
        image: [selfieFile, garmentFile],
        prompt,
        size,
        quality,
        partialImages: 3,
        signal: mediumAbort.signal,
        timing: mediumTiming,
        user,
        onPartial(event) {
          if (finalQueued) return;
          queue.push({
            kind: "partial",
            index: event.partial_image_index,
            b64: event.b64_json,
          });
        },
      });
      mediumSucceeded = true;
      emitFinal(b64);
    } catch (err) {
      if (err instanceof TryOnSafetyRejectionError) safetyRejection = err;
      mediumError = getErrorMessage(err);
      mediumTiming.error = mediumError;
    } finally {
      mediumDone = true;
      fallbackOrFatalAfterMediumFailure();
    }
  })();

  for await (const item of queue) {
    if (item.kind === "fatal") {
      throw item.error;
    }
    yield item;
  }
}

function parseProcessingMs(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function toImageFile(buffer: Buffer, name: string, mimeType: string) {
  const extension = FILE_EXTENSIONS_BY_MIME_TYPE[mimeType];
  if (!extension) {
    throw new Error(`Unsupported ${name} image type: ${mimeType}`);
  }
  return toFile(buffer, `${name}.${extension}`, { type: mimeType });
}

type ImageUpload = Awaited<ReturnType<typeof toImageFile>>;

type ImageEditPartialEvent = {
  partial_image_index: number;
  b64_json: string;
};

type TryOnQueueItem = TryOnStreamEvent | { kind: "fatal"; error: unknown };

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    let resolve = this.resolvers.shift();
    while (resolve) {
      resolve({ value: undefined, done: true });
      resolve = this.resolvers.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function createPassTiming(quality: TryOnQuality, size: string): TryOnPassTiming {
  return {
    quality,
    size,
    requestId: null,
    processingMs: null,
    dateHeader: null,
    usage: null,
    tOpenaiStart: performance.now(),
    tFirstEvent: null,
    tFirstPartial: null,
    tCompleted: null,
    error: null,
  };
}

async function runImageEditPass({
  openai,
  image,
  prompt,
  size,
  quality,
  partialImages,
  signal,
  timing,
  user,
  onPartial,
}: {
  openai: OpenAI;
  image: ImageUpload[];
  prompt: string;
  size: string;
  quality: TryOnQuality;
  partialImages: number;
  signal: AbortSignal;
  timing: TryOnPassTiming;
  user?: string;
  onPartial?: (event: ImageEditPartialEvent) => void;
}) {
  timing.tOpenaiStart = performance.now();
  const { data: stream, response } = await (async () => {
    try {
      return await openai.images
        .edit(
          {
            model: OPENAI_TRYON_MODEL,
            image,
            prompt,
            size,
            quality,
            n: 1,
            output_format: "jpeg",
            output_compression: 85,
            stream: true,
            partial_images: partialImages,
            ...(user ? { user } : {}),
          },
          { signal },
        )
        .withResponse();
    } catch (err) {
      // A safety/moderation block throws here (before the stream resolves). Read
      // the request id off the error and surface a typed error so the route can
      // show actionable guidance instead of the raw OpenAI text.
      if (isSafetyRejection(err)) {
        const reqId =
          (err as { requestID?: string | null }).requestID ??
          err.headers?.get?.("x-request-id") ??
          null;
        timing.requestId = reqId;
        timing.error = "safety_rejected";
        throw new TryOnSafetyRejectionError(reqId, err.code ?? null, {
          cause: err,
        });
      }
      throw err;
    }
  })();

  timing.requestId = response.headers.get("x-request-id");
  timing.processingMs = parseProcessingMs(response.headers.get("openai-processing-ms"));
  timing.dateHeader = response.headers.get("date");

  for await (const event of stream) {
    if (timing.tFirstEvent === null) timing.tFirstEvent = performance.now();

    if (event.type === "image_edit.partial_image") {
      if (timing.tFirstPartial === null) timing.tFirstPartial = performance.now();
      onPartial?.(event);
    } else if (event.type === "image_edit.completed") {
      timing.tCompleted = performance.now();
      timing.usage = event.usage ?? null;
      return event.b64_json;
    }
  }

  throw new Error(`OpenAI ${quality} stream ended without a completed event`);
}

function previewSizeFor(size: TryOnInput["size"]) {
  if (size === "1024x1536" || size === "1536x1024" || size === "1024x1024") {
    return "1024x1024";
  }
  return "1024x1024";
}

function linkAbortSignal(
  parent: AbortSignal | undefined,
  children: AbortController[],
) {
  if (!parent) return () => {};
  const abort = () => {
    for (const child of children) {
      if (!child.signal.aborted) child.abort(parent.reason);
    }
  };
  if (parent.aborted) {
    abort();
    return () => {};
  }
  parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Unknown error";
}

function isAbortError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}
