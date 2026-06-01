// Empirical cost validation for gpt-image-2 generations.
//
// Run after the first 1,000 successful production generations:
//   cd tryonaishopfy && npx tsx scripts/validate-cost-median.ts
//
// NOTE: costUsd now records the TRUE all-in cost per try-on (final pass + the
// low-quality preview pass), so this median reflects real COGS, not just the
// final pass. The pricing ladder ($8.99/60, $29.99/200, $99.99/650; overage
// $0.20/$0.18/$0.16) was designed against a strict $0.115 COGS, where every
// tier's per-included revenue is ~$0.15 and the lowest overage rate is $0.16.
//
// Decision matrix (true all-in COGS):
//   median <= $0.08  -> margins healthy; room to raise included allowances
//                       (Phase 2: drop the preview pass) or lower overage.
//   median in [$0.08, $0.13]  -> ship as-is; priced for strict $0.115, profitable.
//   median >= $0.13  -> INVESTIGATE: approaching per-included revenue (~$0.15)
//                       and the $0.16 overage floor. Confirm the size cost-cap is
//                       active (no 1024x1024), then drop the preview pass or
//                       re-cut included counts in app/lib/plans.ts.
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
  if (medianCost <= 0.08) {
    recommendation =
      "MARGINS_HEALTHY: room to raise included allowances (drop the preview pass) or lower overage.";
  } else if (medianCost >= 0.13) {
    recommendation =
      "INVESTIGATE: median nearing per-included revenue (~$0.15) / $0.16 overage floor. Confirm the size cost-cap is active, then drop the preview pass or re-cut included counts in app/lib/plans.ts.";
  } else {
    recommendation = "SHIP_AS_IS: within the strict $0.115 design envelope.";
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
