/**
 * Build dubai_bruno_313 level table from the authoritative CSV.
 * Source : scripts/dubai313-source.csv  (exactly 313 data rows: size,profit,drop)
 * Output : src/lib/presets/dubai313-levels.json  ({ leverageBase, levels:[...313] })
 *
 * The engine (table-logics.buildLevels) prepends L0 (drop=0) → 314 total orders.
 * Run: node scripts/build-dubai313.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCsv = path.join(__dirname, "dubai313-source.csv");
const outJson = path.join(__dirname, "..", "src", "lib", "presets", "dubai313-levels.json");
const outRaw = path.join(__dirname, "..", "src", "lib", "presets", "dubai313-raw.txt");

const rows = fs
  .readFileSync(srcCsv, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?$/.test(l))
  .map((l) => {
    const [size, profit, drop] = l.split(",").map(Number);
    return { size, profit, drop };
  });

// --- Verify exact count ---
if (rows.length !== 313) {
  console.error(`FAIL: expected 313 data rows, got ${rows.length}`);
  process.exit(1);
}

// --- Verify authoritative tier breakdown (profit/drop → count) ---
const expected = [
  { profit: 20, drop: 20, count: 1 },
  { profit: 20, drop: 40, count: 2 },
  { profit: 20, drop: 60, count: 3 },
  { profit: 20, drop: 80, count: 4 },
  { profit: 20, drop: 100, count: 6 },
  { profit: 25, drop: 130, count: 9 },
  { profit: 25, drop: 160, count: 14 },
  { profit: 25, drop: 190, count: 21 },
  { profit: 30, drop: 230, count: 31 },
  { profit: 45, drop: 270, count: 47 },
  { profit: 60, drop: 310, count: 42 },
  { profit: 70, drop: 310, count: 28 },
  { profit: 100, drop: 350, count: 42 },
  { profit: 110, drop: 350, count: 50 },
  { profit: 125, drop: 350, count: 13 },
];

let idx = 0;
let fail = 0;
for (const tier of expected) {
  for (let k = 0; k < tier.count; k++) {
    const r = rows[idx];
    if (!r || r.profit !== tier.profit || r.drop !== tier.drop) {
      console.error(
        `FAIL row ${idx + 1}: expected profit ${tier.profit}/drop ${tier.drop}, got`,
        r,
      );
      fail++;
    }
    idx++;
  }
}
if (idx !== 313) {
  console.error(`FAIL: tier sum ${idx} !== 313`);
  fail++;
}
// deepest level must be drop 350 / profit 125
const last = rows[rows.length - 1];
if (last.drop !== 350 || last.profit !== 125) {
  console.error("FAIL: deepest level must be drop 350 / profit 125", last);
  fail++;
}
// first level drop must be 20 (2nd order added at basket ROI <= -20%)
if (rows[0].drop !== 20 || rows[0].profit !== 20) {
  console.error("FAIL: first row must be profit 20 / drop 20", rows[0]);
  fail++;
}

if (fail) {
  console.error(`\nBUILD FAILED: ${fail} tier mismatches`);
  process.exit(1);
}

fs.writeFileSync(outJson, JSON.stringify({ leverageBase: 20, levels: rows }, null, 0), "utf8");
fs.writeFileSync(outRaw, rows.map((r) => `${r.size},${r.profit},${r.drop}`).join("\n") + "\n", "utf8");

const tiers = expected
  .map((t) => `p${t.profit}/d${t.drop}×${t.count}`)
  .join("  ");
console.log(`OK wrote ${outJson}`);
console.log(`   313 rows + implicit L0 = 314 total orders`);
console.log(`   tiers: ${tiers}`);
console.log(`   deepest: profit ${last.profit} / drop ${last.drop}`);
