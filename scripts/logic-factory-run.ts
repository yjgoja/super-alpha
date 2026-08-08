/**
 * Unattended logic factory — param search + novel invent + sim + rank + safe promote.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/logic-factory-run.ts --once
 *   npx tsx --env-file=.env scripts/logic-factory-run.ts --continuous
 *   npx tsx scripts/logic-factory-run.ts --once --dry-promote --n 12
 *
 * Env:
 *   FACTORY_AUTO_PROMOTE=1|0
 *   FACTORY_PROMOTE_DEMO_ONLY=1
 *   FACTORY_MAX_LOTS=0.05
 *   FACTORY_SYMBOLS=GBPUSD,EURUSD
 */
import {
  defaultFactoryConfig,
  runFactoryGeneration,
  runFactoryLoop,
} from "../src/lib/logic-factory";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}
function flag(name: string) {
  return process.argv.includes(name);
}

async function main() {
  const continuous = flag("--continuous");
  const dryPromote = flag("--dry-promote");
  const n = Number(arg("--n", "24")) || 24;
  const gens = Number(arg("--gens", continuous ? "0" : "1"));
  const symbols = (arg("--symbols", process.env.FACTORY_SYMBOLS || "GBPUSD,EURUSD") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxLots = Number(arg("--max-lots", process.env.FACTORY_MAX_LOTS || "0.05")) || 0.05;
  const runId =
    arg("--run-id") ||
    process.env.FACTORY_RUN_ID ||
    `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

  const cfg = defaultFactoryConfig({
    runId,
    symbols,
    generationSize: Math.max(6, Math.min(200, n)),
    maxGenerations: continuous ? 0 : Math.max(1, gens || 1),
    continuous,
    maxPromoteLots: maxLots,
    autoPromote: dryPromote ? false : undefined,
    dryPromote,
    barStride: Number(arg("--stride", "20")) || 20,
    sleepMs: Number(arg("--sleep-ms", "8000")) || 8000,
    seeds: (arg("--seeds", "1000,2000,3000,5000,10000,30000") || "1000,2000,3000,5000,10000,30000")
      .split(",")
      .map((x) => Number(x))
      .filter((x) => x > 0),
  });

  console.log("🏭 Logic factory starting", {
    runId: cfg.runId,
    continuous: cfg.continuous,
    autoPromote: cfg.autoPromote && !cfg.dryPromote,
    dryPromote: cfg.dryPromote,
    symbols: cfg.symbols,
    generationSize: cfg.generationSize,
  });

  if (continuous) {
    await runFactoryLoop(cfg);
    return;
  }

  const result = await runFactoryGeneration({
    cfg,
    epoch: 1,
    generation: 1,
    dryPromote: cfg.dryPromote || !cfg.autoPromote,
  });
  console.log(
    JSON.stringify(
      {
        best: result.best
          ? {
              label: result.best.label,
              score: result.best.metrics.score,
              medianMonthReturnPct: result.best.metrics.medianMonthReturnPct,
              consistency: result.best.metrics.consistency,
              kind: result.best.kind,
            }
          : null,
        tested: result.tested,
        outDir: result.outDir,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
