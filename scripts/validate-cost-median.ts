// Empirical cost validation for gpt-image-2 generations.
//
// Run after the first 1,000 successful production generations:
//   cd tryonaishopfy && npx tsx scripts/validate-cost-median.ts
//
// Decision matrix (per Chapter 3 plan):
//   median <= $0.06  -> margins healthy; consider lowering Starter overage from $0.18.
//   median in [$0.06, $0.10]  -> ship as-is.
//   median >= $0.10  -> BLOCK App Store listing; raise plan prices in app/lib/plans.server.ts.
//
// Also reports the p95 and the input-vs-output token mix so you can see whether
// input image tokens are the dominant cost driver (the task spec flags this as a known risk).

import prisma from "../app/db.server";

async function main() {
  const rows = await prisma.usageLog.findMany({
    where: { status: "ok" },
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: {
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
      openaiMs: true,
    },
  });

  if (rows.length < 1000) {
    console.log(
      JSON.stringify({
        event: "validate_cost_median",
        status: "insufficient_data",
        sample_size: rows.length,
        required: 1000,
      }),
    );
    process.exit(0);
  }

  const costs = rows.map((r) => r.costUsd).sort((a, b) => a - b);
  const latencies = rows
    .map((r) => r.openaiMs)
    .filter((m): m is number => typeof m === "number")
    .sort((a, b) => a - b);
  const inputs = rows
    .map((r) => r.inputTokens)
    .filter((n): n is number => typeof n === "number");
  const outputs = rows
    .map((r) => r.outputTokens)
    .filter((n): n is number => typeof n === "number");

  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];
  const mean = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  const medianCost = pct(costs, 0.5);
  const p95Cost = pct(costs, 0.95);
  const meanInput = mean(inputs);
  const meanOutput = mean(outputs);
  const medianLatencyMs = latencies.length ? pct(latencies, 0.5) : null;

  let recommendation: string;
  if (medianCost <= 0.06) {
    recommendation =
      "MARGINS_HEALTHY: consider lowering Starter overage from $0.18.";
  } else if (medianCost >= 0.1) {
    recommendation =
      "BLOCK_LISTING: raise plan prices in app/lib/plans.server.ts before App Store goes live.";
  } else {
    recommendation = "SHIP_AS_IS: placeholder was conservative-enough.";
  }

  console.log(
    JSON.stringify(
      {
        event: "validate_cost_median",
        status: "ok",
        sample_size: rows.length,
        median_cost_usd: medianCost,
        p95_cost_usd: p95Cost,
        mean_input_tokens: meanInput,
        mean_output_tokens: meanOutput,
        median_openai_ms: medianLatencyMs,
        recommendation,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
