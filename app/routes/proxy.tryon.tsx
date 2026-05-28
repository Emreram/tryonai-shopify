import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  computeCostUsd,
  generateTryOn,
  OPENAI_TRYON_MODEL,
} from "../lib/openai.server";
import { verifyProxySignature } from "../lib/proxy.server";
import {
  buildKey as buildRateLimitKey,
  checkAndIncrement as rateLimitCheck,
  decrement as rateLimitDecrement,
} from "../lib/rateLimit.server";
import db from "../db.server";
import {
  PLANS,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  requestId,
  type PlanKey,
} from "../lib/plans";
import { refreshBillingState } from "../lib/billingSync.server";
import { sendTryOnUsageEvent } from "../lib/appEvents.server";

type BlockReason =
  | "trial_expired"
  | "cap_reached"
  | "cost_ceiling"
  | "rate_limited";

async function writeBlockedLog(args: {
  shop: string;
  reqId: string;
  plan: PlanKey;
  size: string;
  cycleStart: Date;
  reason: BlockReason;
}) {
  try {
    await db.usageLog.create({
      data: {
        shop: args.shop,
        requestId: args.reqId,
        openaiRequestId: null,
        plan: args.plan,
        costUsd: 0,
        inputTokens: null,
        outputTokens: null,
        openaiMs: null,
        status: args.reason,
        size: args.size,
        cycleStart: args.cycleStart,
      },
    });
  } catch (logErr) {
    console.error(
      JSON.stringify({
        event: "usage_log_write_failed",
        sub_event: args.reason,
        error: logErr instanceof Error ? logErr.message : String(logErr),
        shop: args.shop,
        request_id: args.reqId,
      }),
    );
  }
}

const MAX_SELFIE_BYTES = 8 * 1024 * 1024;
const MAX_GARMENT_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_SIZES = new Set([
  "1024x1024",
  "1024x1536",
  "1536x1024",
] as const);
type TryOnSize = "1024x1024" | "1024x1536" | "1536x1024";
const DEFAULT_SIZE: TryOnSize = "1024x1536";
const DEFAULT_QUALITY: "low" | "medium" | "high" = "medium";
const SSE_OPEN_PADDING = " ".repeat(64 * 1024);

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let shop: string;
  let customerId: string | null;
  try {
    ({ shop, customerId } = verifyProxySignature(request));
  } catch (err) {
    if (err instanceof Response) return err;
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const tRequestReceived = performance.now();

  const firstXff =
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  let rateLimitKey: string | null = null;
  try {
    rateLimitKey = buildRateLimitKey(shop, customerId, firstXff);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "rate_limit_unkeyable",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const rateLimitVerdict = await rateLimitCheck(rateLimitKey);
  if (!rateLimitVerdict.ok) {
    const cycleStartForLog =
      // Best-effort cycle reference for the blocked-log row; the real billing
      // record is read further down for non-rate-limited paths.
      new Date(0);
    await writeBlockedLog({
      shop,
      reqId: requestId(),
      plan: "trial",
      size: "unknown",
      cycleStart: cycleStartForLog,
      reason: "rate_limited",
    });
    console.warn(
      JSON.stringify({
        event: "rate_limit_hit",
        shop,
        tier: rateLimitVerdict.tier,
        retry_after: rateLimitVerdict.retryAfter,
      }),
    );
    return json(
      {
        error: "rate_limited",
        retryAfter: rateLimitVerdict.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimitVerdict.retryAfter) },
      },
    );
  }

  const installedShop = await db.shop.findUnique({ where: { domain: shop } });
  if (!installedShop) {
    return json({ error: "shop_not_installed" }, { status: 403 });
  }

  await refreshBillingState({ shop });

  const billing = await db.billingState.findUnique({
    where: { shop },
    include: { shopRef: { include: { settings: true } } },
  });
  if (!billing) {
    return json({ error: "shop_not_installed" }, { status: 403 });
  }

  const plan: PlanKey = isPlanKey(billing.plan) ? billing.plan : "trial";
  const settings = billing.shopRef?.settings ?? null;
  const cycleStart =
    billing.currentCycleStart ?? billing.trialStartedAt ?? new Date(0);
  const reqId = requestId();

  if (plan === "trial") {
    const trialAge = Date.now() - billing.trialStartedAt.getTime();
    const trialCount = await db.usageLog.count({
      where: { shop, createdAt: { gte: billing.trialStartedAt }, status: "ok" },
    });
    if (
      trialAge > TRIAL_DAYS * 86_400_000 ||
      trialCount >= TRIAL_TRYONS
    ) {
      await writeBlockedLog({
        shop,
        reqId,
        plan,
        size: "unknown",
        cycleStart,
        reason: "trial_expired",
      });
      return json(
        {
          error: "trial_expired",
          upgradeUrl: "/app/billing",
          trialDaysUsed: Math.floor(trialAge / 86_400_000),
          trialTryOnsUsed: trialCount,
        },
        { status: 402 },
      );
    }
  }

  const cap = computeCap(plan, settings?.capOverride ?? null);
  const used = await db.usageLog.count({
    where: { shop, cycleStart, status: "ok" },
  });
  if (used >= cap) {
    await writeBlockedLog({
      shop,
      reqId,
      plan,
      size: "unknown",
      cycleStart,
      reason: "cap_reached",
    });
    return json(
      {
        error: "cap_reached",
        used,
        cap,
        upgradeUrl: "/app/billing",
      },
      { status: 429 },
    );
  }

  const ceilingRaw = process.env.DAILY_COST_CEILING_USD;
  const ceiling = ceilingRaw ? Number(ceilingRaw) : 0;
  if (Number.isFinite(ceiling) && ceiling > 0) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todaySpend = await db.usageLog.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: startOfDay }, status: "ok" },
    });
    const spend = Number(todaySpend._sum.costUsd ?? 0);
    if (spend >= ceiling) {
      console.error(
        JSON.stringify({
          event: "cost_ceiling_hit",
          spend,
          ceiling,
          shop,
        }),
      );
      await writeBlockedLog({
        shop,
        reqId,
        plan,
        size: "unknown",
        cycleStart,
        reason: "cost_ceiling",
      });
      return json({ error: "service_paused" }, { status: 503 });
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Invalid form data" }, { status: 400 });
  }

  const selfie = formData.get("selfie");
  if (!(selfie instanceof File) || selfie.size === 0) {
    return json({ error: "Missing selfie file" }, { status: 400 });
  }
  if (selfie.size > MAX_SELFIE_BYTES) {
    return json({ error: "Selfie exceeds 8MB" }, { status: 413 });
  }
  const selfieMime = normalizeMimeType(selfie.type);
  if (!isSupportedImageMimeType(selfieMime)) {
    return json(
      { error: "Selfie must be a JPEG, PNG, or WebP image" },
      { status: 400 },
    );
  }

  const garmentFile = formData.get("garment");
  if (!(garmentFile instanceof File) || garmentFile.size === 0) {
    return json({ error: "Upload an item photo to try on." }, { status: 400 });
  }
  if (garmentFile.size > MAX_GARMENT_BYTES) {
    return json({ error: "The item photo exceeds 8MB" }, { status: 413 });
  }
  const garmentMime = normalizeMimeType(garmentFile.type);
  if (!isSupportedImageMimeType(garmentMime)) {
    return json(
      { error: "The item photo must be a JPEG, PNG, or WebP image" },
      { status: 400 },
    );
  }

  const sizeRaw = formData.get("size");
  const size: TryOnSize =
    typeof sizeRaw === "string" && (SUPPORTED_SIZES as Set<string>).has(sizeRaw)
      ? (sizeRaw as TryOnSize)
      : DEFAULT_SIZE;

  const selfieBytes = selfie.size;
  const garmentBytes = garmentFile.size;

  const [selfieBuf, garmentBuf] = await Promise.all([
    selfie.arrayBuffer().then(Buffer.from),
    garmentFile.arrayBuffer().then(Buffer.from),
  ]);

  const tValidated = performance.now();

  const encoder = new TextEncoder();
  const generationAbortController = new AbortController();
  let streamCancelled = false;
  // Flips true once OpenAI completes (its "timing" event is the last frame).
  // If the request aborts/errs before this, we refund the rate-limit bucket
  // so a flaky-network shopper can't self-DOS via dropped SSE retries.
  let openaiCompleted = false;
  const abortGeneration = () => {
    streamCancelled = true;
    generationAbortController.abort();
  };
  request.signal.addEventListener("abort", abortGeneration, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendFrame = (frame: string) => {
        if (streamCancelled) return;
        controller.enqueue(encoder.encode(frame));
      };
      const send = (payload: unknown) => {
        sendFrame(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const tResponseStart = performance.now();
      let timingPayload: unknown = null;
      sendFrame(`: tryonai stream open ${SSE_OPEN_PADDING}\n\n`);
      send({ kind: "meta", requestId: reqId });
      try {
        for await (const event of generateTryOn({
          selfie: selfieBuf,
          selfieMimeType: selfieMime,
          garment: garmentBuf,
          garmentMimeType: garmentMime,
          size,
          signal: generationAbortController.signal,
        })) {
          if (streamCancelled) break;
          if (event.kind === "timing") {
            const t = event.openai;
            const safe = (a: number | null, b: number) =>
              a === null ? null : Math.round(a - b);
            const fromRequest = (a: number | null) => safe(a, tRequestReceived);
            const lowTotal = safe(t.low.tCompleted, t.low.tOpenaiStart);
            const mediumTotal = safe(t.medium.tCompleted, t.medium.tOpenaiStart);
            const log = {
              event: "tryon_complete",
              route_owner: "openai-direct",
              model: OPENAI_TRYON_MODEL,
              quality: DEFAULT_QUALITY,
              size,
              output_format: "jpeg",
              shop,
              request_id: reqId,
              plan,
              selfie_bytes: selfieBytes,
              garment_bytes: garmentBytes,
              openai_request_id: t.requestId,
              openai_processing_ms: t.processingMs,
              openai_date_header: t.dateHeader,
              low_openai_request_id: t.low.requestId,
              low_openai_processing_ms: t.low.processingMs,
              low_size: t.low.size,
              medium_openai_request_id: t.medium.requestId,
              medium_openai_processing_ms: t.medium.processingMs,
              medium_size: t.medium.size,
              preview_source: t.previewSource,
              fallback_to_preview: t.fallbackToPreview,
              warning: t.warning,
              low_total_ms: lowTotal,
              medium_total_ms: mediumTotal,
              timings_ms: {
                validate: Math.round(tValidated - tRequestReceived),
                response_start: Math.round(tResponseStart - tValidated),
                openai_first_event: safe(t.tFirstEvent, t.tOpenaiStart),
                openai_first_partial: safe(t.tFirstPartial, t.tOpenaiStart),
                openai_total: safe(t.tCompleted, t.tOpenaiStart),
                preview: fromRequest(t.tPreview),
                final_delivered: fromRequest(t.tFinalDelivered),
                low_first_event: safe(t.low.tFirstEvent, t.low.tOpenaiStart),
                low_total: lowTotal,
                medium_first_event: safe(t.medium.tFirstEvent, t.medium.tOpenaiStart),
                medium_first_partial: safe(t.medium.tFirstPartial, t.medium.tOpenaiStart),
                medium_total: mediumTotal,
                total_server:
                  t.tCompleted === null
                    ? null
                    : Math.round(t.tCompleted - tRequestReceived),
              },
              usage: t.usage,
              low_usage: t.low.usage,
              medium_usage: t.medium.usage,
              low_error: t.low.error,
              medium_error: t.medium.error,
            };
            console.log(JSON.stringify(log));
            timingPayload = log;
            openaiCompleted = true;
            send({ kind: "timing", ...log });

            try {
              const inputTokens =
                typeof t.usage?.input_tokens === "number"
                  ? Math.round(t.usage.input_tokens)
                  : null;
              const outputTokens =
                typeof t.usage?.output_tokens === "number"
                  ? Math.round(t.usage.output_tokens)
                  : null;
              const openaiMs =
                t.tCompleted !== null
                  ? Math.round(t.tCompleted - t.tOpenaiStart)
                  : null;
              const usageLog = await db.usageLog.create({
                data: {
                  shop,
                  requestId: reqId,
                  openaiRequestId: t.requestId ?? null,
                  plan,
                  costUsd: computeCostUsd(t.usage),
                  inputTokens,
                  outputTokens,
                  openaiMs,
                  status: "ok",
                  size,
                  cycleStart,
                },
              });
              const planDef = PLANS[plan];
              if (plan !== "trial" && planDef.overage !== null) {
                try {
                  const billingEvent = await sendTryOnUsageEvent({
                    shopGid: billing.shopRef?.shopGid,
                    requestId: reqId,
                    timestamp: new Date(),
                  });
                  await db.usageLog.update({
                    where: { id: usageLog.id },
                    data: {
                      billingEventId: billingEvent.eventId,
                      billingEventStatus: billingEvent.status,
                      billingEventError: billingEvent.error?.slice(0, 1000) ?? null,
                    },
                  });
                  console.log(
                    JSON.stringify({
                      event: "app_event_tryon_generated",
                      shop,
                      request_id: reqId,
                      status: billingEvent.status,
                      error: billingEvent.error ?? null,
                    }),
                  );
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  await db.usageLog.update({
                    where: { id: usageLog.id },
                    data: {
                      billingEventId: reqId.slice(0, 64),
                      billingEventStatus: "failed",
                      billingEventError: message.slice(0, 1000),
                    },
                  });
                  console.error(
                    JSON.stringify({
                      event: "app_event_tryon_generated_threw",
                      shop,
                      request_id: reqId,
                      error: message,
                    }),
                  );
                }
              }
            } catch (logErr) {
              console.error(
                JSON.stringify({
                  event: "usage_log_write_failed",
                  error:
                    logErr instanceof Error ? logErr.message : String(logErr),
                  shop,
                  request_id: reqId,
                }),
              );
            }
          } else {
            send(event);
          }
        }
      } catch (err) {
        if (streamCancelled || isAbortError(err)) {
          if (!openaiCompleted && rateLimitKey) {
            await rateLimitDecrement(rateLimitKey);
          }
          return;
        }
        if (!openaiCompleted && rateLimitKey) {
          await rateLimitDecrement(rateLimitKey);
        }
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(
          JSON.stringify({
            event: "tryon_error",
            error: msg,
            shop,
            request_id: reqId,
            timing: timingPayload,
            timings_ms: {
              validate: Math.round(tValidated - tRequestReceived),
              total_to_error: Math.round(performance.now() - tRequestReceived),
            },
          }),
        );
        try {
          await db.usageLog.create({
            data: {
              shop,
              requestId: reqId,
              openaiRequestId: null,
              plan,
              costUsd: 0,
              inputTokens: null,
              outputTokens: null,
              openaiMs: null,
              status: "error",
              size,
              cycleStart,
            },
          });
        } catch (logErr) {
          console.error(
            JSON.stringify({
              event: "usage_log_write_failed",
              sub_event: "tryon_error",
              error: logErr instanceof Error ? logErr.message : String(logErr),
              shop,
              request_id: reqId,
            }),
          );
        }
        send({ kind: "error", error: `Try-on generation failed: ${msg}` });
      } finally {
        request.signal.removeEventListener("abort", abortGeneration);
        if (!streamCancelled) controller.close();
      }
    },
    cancel() {
      abortGeneration();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Content-Encoding": "identity",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function normalizeMimeType(mimeType: string | null | undefined) {
  return mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isSupportedImageMimeType(mimeType: string) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}

function isAbortError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}
