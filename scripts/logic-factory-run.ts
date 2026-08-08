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

  // 합성 폴백을 조용히 넘기지 않는다.
  // bars.ts 는 ohlc-<심볼>-M1.json 이 없으면 난수 시계열로 떨어지는데, 이게
  // 드러나지 않아 8일치 탐색(165,516 후보)이 전부 무의미해진 적이 있다.
  {
    const fs = await import("fs");
    const path = await import("path");
    const missing = cfg.symbols.filter(
      (s) =>
        !fs.existsSync(path.join(process.cwd(), "scripts", "out", `ohlc-${s}-M1.json`)) &&
        !fs.existsSync(path.join(process.cwd(), "scripts", "out", `ohlc-${s}-M15.json`)) &&
        !fs.existsSync(path.join(process.cwd(), "scripts", "out", `ohlc-${s}.json`)),
    );
    if (missing.length) {
      console.warn(
        `\n🔴 실제 시세 없음: ${missing.join(", ")} — 합성(난수) 데이터로 백테스트됩니다. 결과는 실제 성과가 아닙니다.`,
      );
      console.warn(
        `   해결: npx tsx --env-file=.env scripts/_fetch-m1.ts\n`,
      );
      if (process.env.FACTORY_REQUIRE_REAL_BARS === "1") {
        throw new Error(`실제 시세 없이 실행 중단 (${missing.join(", ")})`);
      }
    } else {
      console.log(`✅ 실제 M1 시세 확인: ${cfg.symbols.join(", ")}`);
    }
  }

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
