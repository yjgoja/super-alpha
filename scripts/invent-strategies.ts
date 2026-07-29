/**
 * Offline novel-strategy inventor.
 *
 * Invents ladder DNA beyond registered martin_9_* knob tweaks, plus optional
 * non-runnable mechanism sketches for future engine work.
 *
 * NEVER applies to live bots / open baskets.
 *
 * Usage:
 *   npx tsx scripts/invent-strategies.ts --n 12 --seed 42
 *   npx tsx scripts/invent-strategies.ts --n 5 --seed 1 --json
 */
import {
  compileGenome,
  inventBatch,
  resemblesMartinPreset,
  type InventedCandidate,
} from "../src/lib/strategy-inventor";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

const count = Math.max(1, Math.min(200, Number(arg("--n", "10")) || 10));
const seed = Number(arg("--seed", String(Date.now() % 1_000_000))) || 1;
const sketchRatio = Number(arg("--sketch-ratio", "0.2"));
const asJson = hasFlag("--json");

const batch = inventBatch({ seed, count, sketchRatio });

type Row = {
  label: string;
  candidate: InventedCandidate;
  compiled?: ReturnType<typeof compileGenome>;
  nearMartinPreset?: boolean;
};

const rows: Row[] = batch.map((candidate) => {
  if (candidate.kind === "sketch") {
    return { label: candidate.label, candidate };
  }
  const compiled = compileGenome(candidate.genome);
  return {
    label: candidate.label,
    candidate,
    compiled,
    nearMartinPreset: resemblesMartinPreset(compiled.levels.map((l) => l.drop)),
  };
});

if (asJson) {
  console.log(
    JSON.stringify(
      {
        seed,
        count,
        sketchRatio,
        autoApply: false,
        note: "발굴 후보만 — 봇 자동 적용 없음",
        rows,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`🧬 신규 전략 발명 · seed=${seed} · n=${count} · sketchRatio=${sketchRatio}`);
console.log(`※ 자동 적용 안 함 · 라이브/오픈바스켓 무관 · custom 컴파일 후보만\n`);

for (const row of rows) {
  console.log("─".repeat(72));
  if (row.candidate.kind === "sketch") {
    const s = row.candidate.sketch;
    console.log(`💡 [스케치·엔진필요] ${s.id}`);
    console.log(`  ${s.headline}`);
    console.log(`  진입: ${s.entryRule}`);
    console.log(`  물타기: ${s.dcaRule}`);
    console.log(`  청산: ${s.exitRule}`);
    console.log(`  필요엔진: ${s.requiresEngine.join(", ")}`);
    console.log(`  비고: ${s.notes}`);
    continue;
  }
  const g = row.candidate.genome;
  const c = row.compiled!;
  console.log(`🧪 [실행가능 래더] ${row.label}`);
  if (row.nearMartinPreset) console.log(`  ⚠️ drop열이 martin_9_65와 유사 (참고)`);
  console.log(c.summaryKo);
  console.log(
    `  bot knobs: logic=custom direction=${c.bot.direction} dual=${c.bot.dualDirection} startLots=${c.bot.startLots} entryCount=${c.bot.entryCount}`,
  );
  console.log(
    `  DNA: spacing=${g.spacingFamily}(base=${g.spacing.baseDropRoi},growth=${g.spacing.growth}) lots=${g.lotFamily}(m=${g.lots.multiplier})`,
  );
}

const ladders = rows.filter((r) => r.candidate.kind === "ladder").length;
const sketches = rows.length - ladders;
console.log("\n" + "═".repeat(72));
console.log(`합계 래더(실행가능) ${ladders} · 스케치(엔진필요) ${sketches}`);
console.log(`다음: 히스토리 시뮬/정밀평가 연결 (미구현) → 순위 → 수동 custom 등록`);
