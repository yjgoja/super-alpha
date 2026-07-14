/**
 * Convert CSV lines "size,profit,drop" → levels JSON.
 * Usage: node scripts/build-table-preset.js <raw.txt> <out.json>
 */
const fs = require("fs");
const [,, rawPath, outPath] = process.argv;
if (!rawPath || !outPath) {
  console.error("Usage: node scripts/build-table-preset.js <raw.txt> <out.json>");
  process.exit(1);
}
const lines = fs
  .readFileSync(rawPath, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?$/.test(l));

const levels = lines.map((l) => {
  const [size, profit, drop] = l.split(",").map(Number);
  return { size, profit, drop };
});

fs.writeFileSync(
  outPath,
  JSON.stringify({ leverageBase: 20, levels }, null, 0),
  "utf8",
);
console.log("wrote", outPath, "levels", levels.length);
