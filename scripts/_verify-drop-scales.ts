/**
 * Compare DCA drop distances across martin presets (068 / 35 / 65) vs 313.
 */
import {
  getTableLevels,
  getMartin9Defense,
  resolveLiveTakeProfitPct,
  resolveLiveStopLossPct,
} from "../src/lib/table-logics";

const PUBLIC = [
  "martin_9_068",
  "martin_9_091",
  "martin_9_113",
  "martin_9_35",
  "martin_9_65",
  "dubai_bruno_313",
] as const;

console.log("=== level/drop/SL comparison ===");
for (const logic of PUBLIC) {
  const levels = getTableLevels(logic);
  const defense = getMartin9Defense(logic);
  const drops = levels.slice(1, 6).map((l) => l.drop);
  const sizes = levels.slice(0, 5).map((l) => l.size);
  console.log({
    logic,
    levelCount: levels.length,
    chartPct: defense?.chartPct ?? "(313 bulk)",
    dropScale: defense?.dropScale ?? 1,
    firstDrops: drops,
    firstSizes: sizes,
    tpPct: resolveLiveTakeProfitPct(logic, 0),
    slPct: resolveLiveStopLossPct(logic, 0),
  });
}

// Sanity: 35 drops ~5.2x 068, 65 ~9.7x 068; 091=2x, 113=3x
const d068 = getTableLevels("martin_9_068")[1]!.drop;
const d091 = getTableLevels("martin_9_091")[1]!.drop;
const d113 = getTableLevels("martin_9_113")[1]!.drop;
const d35 = getTableLevels("martin_9_35")[1]!.drop;
const d65 = getTableLevels("martin_9_65")[1]!.drop;
const r091 = d091 / d068;
const r113 = d113 / d068;
const r35 = d35 / d068;
const r65 = d65 / d068;
const ok091 = Math.abs(r091 - 2) < 0.05;
const ok113 = Math.abs(r113 - 3) < 0.05;
const ok35 = Math.abs(r35 - 5.201) < 0.05;
const ok65 = Math.abs(r65 - 9.741) < 0.05;
console.log("\nscale check", {
  d068,
  d091,
  d113,
  d35,
  d65,
  r091: Number(r091.toFixed(3)),
  r113: Number(r113.toFixed(3)),
  r35: Number(r35.toFixed(3)),
  r65: Number(r65.toFixed(3)),
  ok091,
  ok113,
  ok35,
  ok65,
});
if (!ok091 || !ok113 || !ok35 || !ok65) process.exitCode = 2;
else console.log("DROP_SCALE_OK");
