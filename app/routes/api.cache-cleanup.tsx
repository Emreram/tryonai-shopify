import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { purgeExpiredTryOnCache } from "../lib/tryonCache.server";

/**
 * Daily Vercel Cron sweep of the try-on result cache (masterplan A3).
 *
 * Vercel Cron invokes this over an HTTP GET. When the project has a CRON_SECRET
 * env var, Vercel automatically sends `Authorization: Bearer <CRON_SECRET>`, so
 * we gate on it when present. If CRON_SECRET is not configured we still run (so
 * the sweep works before the secret is wired up) but log a warning so it's
 * visible that the endpoint is currently unauthenticated.
 *
 * The crons entry lives in vercel.json (added separately).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runCleanup(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      console.warn(
        JSON.stringify({ event: "cache_cleanup_unauthorized" }),
      );
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }
  } else {
    console.warn(JSON.stringify({ event: "cache_cleanup_unauthenticated" }));
  }

  try {
    const { deleted } = await purgeExpiredTryOnCache();
    console.log(JSON.stringify({ event: "tryon_cache_cron_swept", deleted }));
    return jsonResponse({ ok: true, deleted });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tryon_cache_cron_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse({ ok: false, error: "cleanup_failed" }, 500);
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) =>
  runCleanup(request);

export const action = async ({ request }: ActionFunctionArgs) =>
  runCleanup(request);
