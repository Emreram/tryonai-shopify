// OpenRouter transport: credentials, error taxonomy, and the streaming Image API.
//
// Everything this app spends money on goes through OpenRouter, so a single
// OPENROUTER_API_KEY is the only model credential the deployment needs.
//
// Two OpenRouter surfaces are used:
//   POST /api/v1/images            -> gpt-image-2 try-on renders
//   POST /api/v1/chat/completions  -> structured text (see textModel.server.ts)
//
// Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
//       https://openrouter.ai/docs/api_reference/errors-and-debugging
//
// NOTE ON THE IMAGE API SHAPE. This is NOT OpenAI's `/v1/images/edits`. It is a
// JSON endpoint (no multipart), input images ride as `input_references` data
// URLs, there is no `size` parameter (use `aspect_ratio`), and the SSE event
// types are `image_generation.*` rather than `image_edit.*`. Capabilities were
// verified against the live discovery API:
//   curl https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints
// which reports for the `openai` endpoint: aspect_ratio (1:1|3:2|2:3|4:3|3:4|
// 16:9|9:16|21:9|auto), quality (auto|low|medium|high), background (auto|opaque),
// n (1-10), input_references (0-16), output_compression (0-100), streaming true.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * gpt-image-2 as addressed on OpenRouter. Unlike the direct OpenAI API there is
 * no dated snapshot slug here (OpenRouter publishes the rolling `openai/
 * gpt-image-2` only), so renders are NOT pinned to a snapshot and can shift when
 * OpenAI rolls the model forward. This string is part of the try-on cache key,
 * so changing it correctly invalidates previously cached renders.
 */
export const TRYON_IMAGE_MODEL = "openai/gpt-image-2";

/**
 * Auth + attribution headers. `HTTP-Referer` / `X-Title` are optional and make
 * the app identifiable on openrouter.ai; they affect nothing functionally.
 */
export function openRouterHeaders(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "X-Title": "TryOnAI",
  };
  const referer = process.env.SHOPIFY_APP_URL || process.env.APPLICATION_URL;
  if (referer) headers["HTTP-Referer"] = referer;
  return headers;
}

export const OPENROUTER_IMAGES_URL = `${OPENROUTER_BASE_URL}/images`;
export const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;

// ---- errors ----------------------------------------------------------------

export type ModelFailureKind =
  /** 402 — the OpenRouter account/key is out of credits. */
  | "billing"
  /** 429 — rate limited; `Retry-After` may be present. */
  | "throttle"
  /** 401 — disabled, revoked, or malformed key. */
  | "auth"
  /** 403 — moderation or guardrail block (input was refused). */
  | "moderation"
  /** 404 / unknown model slug. */
  | "model"
  /** 502 / 503 / 5xx — provider down or no eligible provider. */
  | "upstream"
  /** 400 and anything unclassified. */
  | "unknown";

export class ModelError extends Error {
  readonly kind: ModelFailureKind;
  readonly status: number | null;
  /** OpenRouter's stable `error.metadata.error_type`, when present. */
  readonly errorType: string | null;
  /** The upstream provider's own code, via `error.metadata.provider_code`. */
  readonly providerCode: string | null;
  readonly retryAfterSeconds: number | null;
  /** True only for conditions a later retry could plausibly clear. */
  readonly retryable: boolean;

  constructor(args: {
    kind: ModelFailureKind;
    status: number | null;
    message: string;
    errorType?: string | null;
    providerCode?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(args.message);
    this.name = "ModelError";
    this.kind = args.kind;
    this.status = args.status;
    this.errorType = args.errorType ?? null;
    this.providerCode = args.providerCode ?? null;
    this.retryAfterSeconds = args.retryAfterSeconds ?? null;
    this.retryable =
      args.kind === "throttle" ||
      args.kind === "upstream" ||
      args.kind === "unknown";
  }
}

/**
 * Maps an OpenRouter failure to a kind.
 *
 * Note how this differs from talking to OpenAI directly: OpenRouter signals
 * "out of credits" with **402 Payment Required** and its own guardrail blocks
 * with **403**, whereas OpenAI overloads 429 for billing. Getting this mapping
 * wrong is what makes an unpaid balance look like a traffic spike.
 *
 * The upstream provider's OWN moderation verdict is different again: OpenAI's
 * image safety system is relayed as a **400** whose message reads "rejected by
 * the safety system" (observed live against gpt-image-2), so the message is
 * inspected before falling back to "unknown". That distinction matters because
 * a safety rejection is the shopper's photo, not an outage, and gets different
 * storefront copy.
 */
function kindForFailure(status: number, message: string): ModelFailureKind {
  if (status === 402) return "billing";
  if (status === 401) return "auth";
  if (status === 403) return "moderation";
  if (status === 429) return "throttle";
  if (status === 404) return "model";
  if (status === 408 || status >= 500) return "upstream";

  const lowered = message.toLowerCase();
  if (
    lowered.includes("safety system") ||
    lowered.includes("content policy") ||
    lowered.includes("moderation")
  ) {
    return "moderation";
  }
  return "unknown";
}

/**
 * Builds a `ModelError` from a non-OK response, pulling OpenRouter's typed
 * `error_type` / `provider_code` out of the body when the body is JSON.
 * Never throws: a body that fails to parse still yields a usable error.
 */
export async function modelErrorFromResponse(
  response: Response,
): Promise<ModelError> {
  let message = `OpenRouter request failed with HTTP ${response.status}`;
  let errorType: string | null = null;
  let providerCode: string | null = null;
  let detailCode: number | null = null;

  const bodyText = await response.text().catch(() => "");
  if (bodyText) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      const detail = readErrorDetail(parsed);
      if (detail.message) message = detail.message;
      errorType = detail.errorType;
      providerCode = detail.providerCode;
      detailCode = detail.code;
    } catch {
      message = `${message}: ${bodyText.slice(0, 300)}`;
    }
  }

  const retryAfterRaw = Number(response.headers.get("retry-after"));
  const retryAfterSeconds =
    Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : null;

  // Prefer the body's own `error.code`: a provider failure that arrives after
  // OpenRouter has already committed a 200 (which it does as soon as a provider
  // accepts the request) carries the real status only in the body.
  const effectiveStatus = detailCode ?? response.status;

  return new ModelError({
    kind: kindForFailure(effectiveStatus, message),
    status: effectiveStatus,
    message,
    errorType,
    providerCode,
    retryAfterSeconds,
  });
}

interface ErrorDetail {
  message: string | null;
  /** OpenRouter mirrors the HTTP status here; authoritative on a 200 body. */
  code: number | null;
  errorType: string | null;
  providerCode: string | null;
}

/**
 * Reads `{ error: { code, message, metadata: { error_type, provider_code } } }`.
 * Narrows with `in`/`typeof` at every hop — the body is untrusted network JSON.
 */
function readErrorDetail(body: unknown): ErrorDetail {
  const empty: ErrorDetail = {
    message: null,
    code: null,
    errorType: null,
    providerCode: null,
  };
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return empty;
  }
  const error = body.error;
  if (typeof error !== "object" || error === null) return empty;

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : null;
  const code =
    "code" in error && typeof error.code === "number" ? error.code : null;

  let errorType: string | null = null;
  let providerCode: string | null = null;
  if ("metadata" in error) {
    const metadata = error.metadata;
    if (typeof metadata === "object" && metadata !== null) {
      if ("error_type" in metadata && typeof metadata.error_type === "string") {
        errorType = metadata.error_type;
      }
      if (
        "provider_code" in metadata &&
        typeof metadata.provider_code === "string"
      ) {
        providerCode = metadata.provider_code;
      }
    }
  }
  return { message, code, errorType, providerCode };
}

/**
 * Shopper-facing copy. Deliberately identical for every operator-side fault
 * (billing, auth, model, upstream): none are the shopper's doing and none are
 * fixed by retrying sooner, so surfacing "402" or "out of credits" on a
 * storefront only alarms customers and merchants.
 */
export function shopperMessageFor(kind: ModelFailureKind): string {
  switch (kind) {
    case "throttle":
      return "Virtual try-on is busy right now. Please try again in a minute.";
    case "moderation":
      return (
        "We couldn't create a try-on from that photo. For best results, " +
        "upload a clear, well-lit photo of just you, facing the camera — " +
        "with no one else in the frame."
      );
    default:
      return "Virtual try-on is temporarily unavailable. Please check back soon.";
  }
}
