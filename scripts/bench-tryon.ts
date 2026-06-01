// ============================================================================
// bench-tryon.ts — dev-only A/B benchmark: OpenAI gpt-image-2 vs FASHN v1.6
// ============================================================================
//
// Produces the latency / cost / quality A/B data the masterplan needs by running
// real selfie+garment pairs through both providers and recording wall-clock
// latency, time-to-first-event (OpenAI streaming), and per-try-on cost.
//
// THIS IS A DEV-ONLY HARNESS. It is not imported by the app at runtime; it only
// reuses app/lib/openai.server.ts (generateTryOn / computeCostUsd) and
// app/lib/fashn.server.ts (generateTryOnFashnWithTiming). No new npm deps — pure
// Node 20+ (global fetch, node:fs, performance.now).
//
// ---------------------------------------------------------------------------
// HOW TO RUN
// ---------------------------------------------------------------------------
//   cd tryonaishopfy
//   # Required env vars (per provider you intend to run):
//   #   OPENAI_API_KEY=sk-...     (needed for --provider=openai or both)
//   #   FASHN_API_KEY=fa-...      (needed for --provider=fashn  or both)
//   #
//   #   Windows PowerShell:
//   #     $env:OPENAI_API_KEY="sk-..."; $env:FASHN_API_KEY="fa-..."
//   #   bash:
//   #     export OPENAI_API_KEY=sk-...  FASHN_API_KEY=fa-...
//
//   npx tsx scripts/bench-tryon.ts [pairsDir] [--provider=both] [--n=10] \
//       [--out=./bench/out] [--timeout=120000]
//
// Examples:
//   npx tsx scripts/bench-tryon.ts
//   npx tsx scripts/bench-tryon.ts ./bench/pairs --provider=openai --n=5
//   npx tsx scripts/bench-tryon.ts ./bench/pairs --provider=both --out=./bench/out
//
// ---------------------------------------------------------------------------
// INPUT LAYOUT (default ./bench/pairs)
// ---------------------------------------------------------------------------
//   bench/pairs/
//     model-a/
//       selfie.jpg      (or selfie.png / selfie.webp)
//       garment.jpg     (or garment.png / garment.webp)
//     model-b/
//       selfie.png
//       garment.webp
//     ...
//   Each subfolder = one pair. The files MUST be named selfie.* and garment.*
//   (any of jpg/jpeg/png/webp). MIME type is inferred from the extension.
//
// ---------------------------------------------------------------------------
// OUTPUTS (default ./bench/out)
// ---------------------------------------------------------------------------
//   <out>/<pair>__openai.jpg   — final OpenAI image (decoded from b64 JPEG)
//   <out>/<pair>__fashn.jpg    — final FASHN image
//   <out>/results.json         — full structured results array
//   <out>/results.csv          — columns: pair,provider,model,latency_ms,
//                                first_event_ms,cost_usd,ok,error
//   ...and a per-provider summary table (median/p95 latency, mean cost) to stdout.
//
// CLI args (positional pairsDir + flags, order-independent for flags):
//   pairsDir         positional, default ./bench/pairs
//   --provider=      openai | fashn | both           (default both)
//   --n=             integer limit on number of pairs (default: all)
//   --out=           output dir                       (default ./bench/out)
//   --timeout=       global per-run timeout in ms     (default 120000)
// ============================================================================

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  computeCostUsd,
  generateTryOn,
  OPENAI_TRYON_MODEL,
  type TryOnUsage,
} from "../app/lib/openai.server";

// --- FASHN contract (documented; module may not exist yet) ------------------
// app/lib/fashn.server.ts is expected to export:
//   export const FASHN_TRYON_MODEL: string;
//   export function generateTryOnFashnWithTiming(input): Promise<{
//     b64: string;            // raw base64 JPEG (no data: prefix)
//     timings: unknown;       // provider timing detail (shape TBD)
//     costUsd: number;
//   }>;
// Input mirrors TryOnInput's fields the harness controls (selfie/garment buffers
// + mime types, optional prompt/size, AbortSignal). We load it dynamically so the
// OpenAI side of the bench still works before fashn.server.ts lands.
interface FashnTryOnResult {
  b64: string;
  timings: unknown;
  costUsd: number;
}
interface FashnInput {
  selfie: Buffer;
  selfieMimeType: string;
  garment: Buffer;
  garmentMimeType: string;
  prompt?: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  signal?: AbortSignal;
}
interface FashnModule {
  FASHN_TRYON_MODEL: string;
  generateTryOnFashnWithTiming: (
    input: FashnInput,
  ) => Promise<FashnTryOnResult>;
}

type Provider = "openai" | "fashn";

interface BenchOptions {
  pairsDir: string;
  providers: Provider[];
  limit: number | null;
  outDir: string;
  timeoutMs: number;
}

interface PairInput {
  name: string;
  selfie: Buffer;
  selfieMime: string;
  garment: Buffer;
  garmentMime: string;
}

interface RunResult {
  pair: string;
  provider: Provider;
  model: string;
  latencyMs: number | null;
  firstEventMs: number | null; // openai only
  costUsd: number | null;
  ok: boolean;
  error: string | null;
}

const SIZE = "1024x1536" as const;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function log(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...extra }));
}

function logErr(event: string, extra: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ event, ...extra }));
}

function parseArgs(argv: string[]): BenchOptions {
  let pairsDir = "./bench/pairs";
  let provider = "both";
  let limit: number | null = null;
  let outDir = "./bench/out";
  let timeoutMs = 120_000;

  let positionalSeen = false;
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      // Split on the FIRST "=" only, so values that themselves contain "="
      // (e.g. a path) are preserved intact.
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const rawKey = eq === -1 ? body : body.slice(0, eq);
      const rawVal = eq === -1 ? "" : body.slice(eq + 1);
      const key = rawKey.trim();
      const val = rawVal.trim();
      switch (key) {
        case "provider":
          provider = val.toLowerCase();
          break;
        case "n": {
          const n = Number.parseInt(val, 10);
          if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`--n must be a positive integer, got "${val}"`);
          }
          limit = n;
          break;
        }
        case "out":
          if (!val) throw new Error("--out requires a path");
          outDir = val;
          break;
        case "timeout": {
          const t = Number.parseInt(val, 10);
          if (!Number.isFinite(t) || t <= 0) {
            throw new Error(`--timeout must be a positive integer (ms), got "${val}"`);
          }
          timeoutMs = t;
          break;
        }
        default:
          throw new Error(`Unknown flag --${key}`);
      }
    } else if (!positionalSeen) {
      pairsDir = arg;
      positionalSeen = true;
    } else {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
  }

  let providers: Provider[];
  switch (provider) {
    case "openai":
      providers = ["openai"];
      break;
    case "fashn":
      providers = ["fashn"];
      break;
    case "both":
      providers = ["openai", "fashn"];
      break;
    default:
      throw new Error(`--provider must be openai|fashn|both, got "${provider}"`);
  }

  return {
    pairsDir: resolve(pairsDir),
    providers,
    limit,
    outDir: resolve(outDir),
    timeoutMs,
  };
}

function findImage(dir: string, stem: "selfie" | "garment"): { buf: Buffer; mime: string } | null {
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const candidate = join(dir, `${stem}${ext}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { buf: readFileSync(candidate), mime: MIME_BY_EXT[ext] };
    }
  }
  // Fall back to any file that starts with the stem (e.g. selfie-1.jpg).
  for (const entry of readdirSync(dir)) {
    const ext = extname(entry).toLowerCase();
    const base = basename(entry, ext).toLowerCase();
    if ((base === stem || base.startsWith(`${stem}`)) && MIME_BY_EXT[ext]) {
      const full = join(dir, entry);
      if (statSync(full).isFile()) {
        return { buf: readFileSync(full), mime: MIME_BY_EXT[ext] };
      }
    }
  }
  return null;
}

function loadPairs(pairsDir: string, limit: number | null): PairInput[] {
  if (!existsSync(pairsDir) || !statSync(pairsDir).isDirectory()) {
    throw new Error(`Pairs directory not found: ${pairsDir}`);
  }
  const subdirs = readdirSync(pairsDir)
    .map((name) => ({ name, full: join(pairsDir, name) }))
    .filter(({ full }) => statSync(full).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const pairs: PairInput[] = [];
  for (const { name, full } of subdirs) {
    const selfie = findImage(full, "selfie");
    const garment = findImage(full, "garment");
    if (!selfie || !garment) {
      logErr("bench_pair_skipped", {
        pair: name,
        reason: !selfie ? "missing selfie.*" : "missing garment.*",
      });
      continue;
    }
    pairs.push({
      name,
      selfie: selfie.buf,
      selfieMime: selfie.mime,
      garment: garment.buf,
      garmentMime: garment.mime,
    });
    if (limit !== null && pairs.length >= limit) break;
  }
  return pairs;
}

async function loadFashnModule(): Promise<FashnModule | null> {
  try {
    const mod = (await import("../app/lib/fashn.server")) as Partial<FashnModule>;
    if (typeof mod.generateTryOnFashnWithTiming !== "function") {
      logErr("bench_fashn_module_invalid", {
        reason: "generateTryOnFashnWithTiming export missing",
      });
      return null;
    }
    return {
      // Fallback matches the real exported id ("tryon-v1.6") in case the export
      // is ever missing; in practice fashn.server.ts always provides it.
      FASHN_TRYON_MODEL: mod.FASHN_TRYON_MODEL ?? "tryon-v1.6",
      generateTryOnFashnWithTiming: mod.generateTryOnFashnWithTiming,
    };
  } catch (err) {
    logErr("bench_fashn_module_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`bench timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function saveImage(outDir: string, pair: string, provider: Provider, b64: string) {
  const path = join(outDir, `${pair}__${provider}.jpg`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return path;
}

async function runOpenAI(pair: PairInput, opts: BenchOptions): Promise<RunResult> {
  const { signal, clear } = withTimeout(opts.timeoutMs);
  const t0 = performance.now();
  let firstEventMs: number | null = null;
  let finalB64: string | null = null;
  let usage: TryOnUsage | null = null;
  // Sum of final (medium) + preview (low) pass cost, matching production COGS.
  let costUsd: number | null = null;

  try {
    for await (const event of generateTryOn({
      selfie: pair.selfie,
      selfieMimeType: pair.selfieMime,
      garment: pair.garment,
      garmentMimeType: pair.garmentMime,
      size: SIZE,
      signal,
    })) {
      if (
        firstEventMs === null &&
        (event.kind === "preview" || event.kind === "partial")
      ) {
        firstEventMs = performance.now() - t0;
      }
      if (event.kind === "completed") {
        finalB64 = event.b64;
      } else if (event.kind === "timing") {
        usage = event.openai.usage;
        costUsd =
          computeCostUsd(event.openai.medium.usage) +
          computeCostUsd(event.openai.low.usage);
      }
    }
  } catch (err) {
    clear();
    return {
      pair: pair.name,
      provider: "openai",
      model: OPENAI_TRYON_MODEL,
      latencyMs: Math.round(performance.now() - t0),
      firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
      costUsd,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  clear();

  const latencyMs = Math.round(performance.now() - t0);
  if (!finalB64) {
    return {
      pair: pair.name,
      provider: "openai",
      model: OPENAI_TRYON_MODEL,
      latencyMs,
      firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
      costUsd,
      ok: false,
      error: "stream ended without a completed image",
    };
  }

  const outPath = saveImage(opts.outDir, pair.name, "openai", finalB64);
  log("bench_run_ok", {
    pair: pair.name,
    provider: "openai",
    model: OPENAI_TRYON_MODEL,
    latency_ms: latencyMs,
    first_event_ms: firstEventMs === null ? null : Math.round(firstEventMs),
    cost_usd: costUsd,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    out: outPath,
  });

  return {
    pair: pair.name,
    provider: "openai",
    model: OPENAI_TRYON_MODEL,
    latencyMs,
    firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
    costUsd,
    ok: true,
    error: null,
  };
}

async function runFashn(
  pair: PairInput,
  opts: BenchOptions,
  fashn: FashnModule,
): Promise<RunResult> {
  const { signal, clear } = withTimeout(opts.timeoutMs);
  const t0 = performance.now();
  try {
    const result = await fashn.generateTryOnFashnWithTiming({
      selfie: pair.selfie,
      selfieMimeType: pair.selfieMime,
      garment: pair.garment,
      garmentMimeType: pair.garmentMime,
      size: SIZE,
      signal,
    });
    clear();
    const latencyMs = Math.round(performance.now() - t0);
    if (!result.b64) {
      return {
        pair: pair.name,
        provider: "fashn",
        model: fashn.FASHN_TRYON_MODEL,
        latencyMs,
        firstEventMs: null,
        costUsd: result.costUsd ?? null,
        ok: false,
        error: "fashn returned no image",
      };
    }
    const outPath = saveImage(opts.outDir, pair.name, "fashn", result.b64);
    log("bench_run_ok", {
      pair: pair.name,
      provider: "fashn",
      model: fashn.FASHN_TRYON_MODEL,
      latency_ms: latencyMs,
      cost_usd: result.costUsd ?? null,
      out: outPath,
    });
    return {
      pair: pair.name,
      provider: "fashn",
      model: fashn.FASHN_TRYON_MODEL,
      latencyMs,
      firstEventMs: null,
      costUsd: result.costUsd ?? null,
      ok: true,
      error: null,
    };
  } catch (err) {
    clear();
    return {
      pair: pair.name,
      provider: "fashn",
      model: fashn.FASHN_TRYON_MODEL,
      latencyMs: Math.round(performance.now() - t0),
      firstEventMs: null,
      costUsd: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- stats / reporting ------------------------------------------------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function mean(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(results: RunResult[]): string {
  const header = [
    "pair",
    "provider",
    "model",
    "latency_ms",
    "first_event_ms",
    "cost_usd",
    "ok",
    "error",
  ];
  const lines = [header.join(",")];
  for (const r of results) {
    lines.push(
      [
        csvCell(r.pair),
        csvCell(r.provider),
        csvCell(r.model),
        csvCell(r.latencyMs),
        csvCell(r.firstEventMs),
        csvCell(r.costUsd),
        csvCell(r.ok),
        csvCell(r.error),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function printSummaryTable(results: RunResult[], providers: Provider[]) {
  const rows: Array<{
    provider: string;
    runs: string;
    ok: string;
    medianMs: string;
    p95Ms: string;
    meanCost: string;
  }> = [];

  for (const provider of providers) {
    const all = results.filter((r) => r.provider === provider);
    const ok = all.filter((r) => r.ok);
    const latencies = ok
      .map((r) => r.latencyMs)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    const costs = ok
      .map((r) => r.costUsd)
      .filter((n): n is number => typeof n === "number");

    const median = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const meanCost = mean(costs);

    rows.push({
      provider,
      runs: String(all.length),
      ok: String(ok.length),
      medianMs: median === null ? "-" : `${Math.round(median)}`,
      p95Ms: p95 === null ? "-" : `${Math.round(p95)}`,
      meanCost: meanCost === null ? "-" : `$${meanCost.toFixed(5)}`,
    });
  }

  const headers = ["provider", "runs", "ok", "median_ms", "p95_ms", "mean_cost"];
  const cols = [
    ["provider", ...rows.map((r) => r.provider)],
    ["runs", ...rows.map((r) => r.runs)],
    ["ok", ...rows.map((r) => r.ok)],
    ["median_ms", ...rows.map((r) => r.medianMs)],
    ["p95_ms", ...rows.map((r) => r.p95Ms)],
    ["mean_cost", ...rows.map((r) => r.meanCost)],
  ];
  const widths = cols.map((c) => Math.max(...c.map((v) => v.length)));
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log("");
  console.log("=== try-on benchmark summary ===");
  console.log(fmtRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(
      fmtRow([r.provider, r.runs, r.ok, r.medianMs, r.p95Ms, r.meanCost]),
    );
  }
  console.log("");
}

// --- main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.providers.includes("openai") && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set (required for --provider including openai)");
  }
  if (opts.providers.includes("fashn") && !process.env.FASHN_API_KEY) {
    throw new Error("FASHN_API_KEY is not set (required for --provider including fashn)");
  }

  const pairs = loadPairs(opts.pairsDir, opts.limit);
  if (pairs.length === 0) {
    throw new Error(
      `No valid pairs found in ${opts.pairsDir} (each subfolder needs selfie.* and garment.*)`,
    );
  }

  mkdirSync(opts.outDir, { recursive: true });

  // Resolve providers actually runnable. FASHN is dropped (with a warning) if its
  // module isn't present yet, so the OpenAI half of the bench still completes.
  let fashn: FashnModule | null = null;
  const activeProviders: Provider[] = [];
  for (const provider of opts.providers) {
    if (provider === "fashn") {
      fashn = await loadFashnModule();
      if (!fashn) {
        logErr("bench_provider_disabled", {
          provider: "fashn",
          reason: "app/lib/fashn.server.ts unavailable or invalid",
        });
        continue;
      }
    }
    activeProviders.push(provider);
  }

  if (activeProviders.length === 0) {
    throw new Error("No runnable providers (FASHN module missing and openai not selected)");
  }

  log("bench_start", {
    pairs_dir: opts.pairsDir,
    out_dir: opts.outDir,
    providers: activeProviders,
    pair_count: pairs.length,
    timeout_ms: opts.timeoutMs,
  });

  const results: RunResult[] = [];
  for (const pair of pairs) {
    for (const provider of activeProviders) {
      log("bench_run_start", { pair: pair.name, provider });
      let result: RunResult;
      if (provider === "openai") {
        result = await runOpenAI(pair, opts);
      } else {
        result = await runFashn(pair, opts, fashn!);
      }
      if (!result.ok) {
        logErr("bench_run_failed", {
          pair: result.pair,
          provider: result.provider,
          error: result.error,
          latency_ms: result.latencyMs,
        });
      }
      results.push(result);
    }
  }

  const jsonPath = join(opts.outDir, "results.json");
  const csvPath = join(opts.outDir, "results.csv");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pairsDir: opts.pairsDir,
        outDir: opts.outDir,
        providers: activeProviders,
        size: SIZE,
        timeoutMs: opts.timeoutMs,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(csvPath, toCsv(results));

  log("bench_done", {
    total_runs: results.length,
    ok_runs: results.filter((r) => r.ok).length,
    results_json: jsonPath,
    results_csv: csvPath,
  });

  printSummaryTable(results, activeProviders);
}

main().catch((err) => {
  logErr("bench_fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
