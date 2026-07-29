/**
 * QA for novel strategy inventor — offline, no MetaAPI / no live apply.
 */
import {
  buildDropLadder,
  buildLotLadder,
  compileGenome,
  inventBatch,
  inventLadderGenome,
  mutateLadderGenome,
  SPACING_FAMILIES,
  LOT_FAMILIES,
} from "../src/lib/strategy-inventor";

let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1) Invent produces runnable ladders with valid bounds
const g0 = inventLadderGenome(42);
assert("genome runnable", g0.runnable === true);
assert("rounds in 2..60", g0.rounds >= 2 && g0.rounds <= 60);
assert("known spacing family", SPACING_FAMILIES.includes(g0.spacingFamily));
assert("known lot family", LOT_FAMILIES.includes(g0.lotFamily));

// 2) Compile respects API-ish bounds
const c0 = compileGenome(g0);
assert("payload mode levels", c0.payload.mode === "levels");
assert("logic custom", c0.bot.logic === "custom");
assert("levels length == rounds", c0.levels.length === Math.min(60, Math.max(2, g0.rounds)));
assert("L0 drop 0", c0.levels[0]?.drop === 0);
assert(
  "drops non-decreasing",
  c0.levels.every((lv, i) => i === 0 || lv.drop >= c0.levels[i - 1]!.drop),
);
assert(
  "lots in (0,100]",
  c0.levels.every((lv) => lv.lots > 0 && lv.lots <= 100),
);
assert(
  "tp in 1..500",
  (c0.payload.takeProfitPct ?? 0) >= 1 && (c0.payload.takeProfitPct ?? 0) <= 500,
);
assert(
  "sl in 0..5000 and > last drop",
  (c0.payload.stopLossPct ?? 0) >= 0 &&
    (c0.payload.stopLossPct ?? 0) <= 5000 &&
    (c0.payload.stopLossPct ?? 0) > (c0.levels.at(-1)?.drop ?? 0),
);
assert("autoApply never implied", c0.summaryKo.includes("자동 적용 안 함"));

// 3) All spacing families produce finite mono ladders
for (const family of SPACING_FAMILIES) {
  const g = {
    ...inventLadderGenome(100 + SPACING_FAMILIES.indexOf(family)),
    spacingFamily: family,
    rounds: 9,
  };
  const drops = buildDropLadder(g);
  assert(
    `spacing ${family} L0=0 mono`,
    drops[0] === 0 && drops.every((d, i) => i === 0 || d >= drops[i - 1]!),
  );
}

// 4) All lot families positive
for (const family of LOT_FAMILIES) {
  const g = {
    ...inventLadderGenome(200 + LOT_FAMILIES.indexOf(family)),
    lotFamily: family,
    rounds: 8,
  };
  const lots = buildLotLadder(g);
  assert(
    `lots ${family} positive`,
    lots.length === 8 && lots.every((x) => x >= 0.01 && x <= 100),
  );
}

// 5) Mutation keeps runnable
const mut = mutateLadderGenome(g0, 99);
assert("mutate runnable", mut.runnable === true);
const cm = compileGenome(mut);
assert("mutate compile levels>0", cm.levels.length >= 2);

// 6) Batch mixes ladders + sketches; sketches not compiled as custom
const batch = inventBatch({ seed: 7, count: 40, sketchRatio: 0.25 });
const ladders = batch.filter((b) => b.kind === "ladder");
const sketches = batch.filter((b) => b.kind === "sketch");
assert("batch has ladders", ladders.length > 0);
assert("batch has sketches", sketches.length > 0);
assert(
  "sketches require engine",
  sketches.every((s) => s.kind === "sketch" && s.sketch.requiresEngine.length > 0),
);
assert(
  "sketches not runnable",
  sketches.every((s) => s.kind === "sketch" && s.sketch.runnable === false),
);

// 7) Structural diversity — not only one family
const families = new Set(ladders.map((l) => (l.kind === "ladder" ? l.genome.spacingFamily : "")));
assert("diverse spacing families", families.size >= 2, `got ${[...families].join(",")}`);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll strategy-inventor checks passed.");
