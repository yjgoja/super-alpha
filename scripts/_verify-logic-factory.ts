/**
 * Offline QA for logic factory — no MetaAPI required (synthetic bars).
 */
import {
  defaultFactoryConfig,
  inventNovelCandidates,
  inventPresetParamCandidates,
  runFactoryGeneration,
  simulateCandidate,
  synthesizeBars,
  strideBars,
} from "../src/lib/logic-factory";

let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const param = inventPresetParamCandidates({
    seed: 11,
    count: 6,
    symbols: ["GBPUSD"],
  });
  assert("param candidates", param.length === 6);
  assert(
    "param runnable presets",
    param.every((c) => c.runnable && c.levels.length >= 2 && c.kind === "preset_param"),
  );

  const novel = inventNovelCandidates({ seed: 22, count: 4, symbols: ["GBPUSD", "EURUSD"] });
  assert("novel candidates", novel.length === 4);
  assert(
    "novel custom logic",
    novel.every((c) => c.bot.logic === "custom" && c.levels[0]?.drop === 0),
  );

  const bars = strideBars(synthesizeBars({ symbol: "GBPUSD", seed: 7, bars: 5_000 }), 10);
  assert("synth bars", bars.length > 100);

  const metrics = simulateCandidate(param[0]!, bars, [1000]);
  assert("sim finite score", Number.isFinite(metrics.score));
  assert("sim has months or empty ok", Array.isArray(metrics.months));

  const cfg = defaultFactoryConfig({
    runId: "verify-factory",
    symbols: ["GBPUSD"],
    generationSize: 10,
    novelRatio: 0.4,
    sketchRatio: 0.1,
    seeds: [1000],
    barStride: 25,
    autoPromote: false,
    maxGenerations: 1,
  });

  const result = await runFactoryGeneration({
    cfg,
    epoch: 1,
    generation: 1,
    dryPromote: true,
  });
  assert("epoch tested>0", result.tested >= 10);
  assert("epoch ranked", result.precise > 0);
  assert("leaderboard best", !!result.best);
  assert("outDir set", result.outDir.includes("logic-factory"));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nAll logic-factory checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
