const fs = require("fs");
const data = JSON.parse(
  fs.readFileSync("src/lib/presets/dca1000-levels.json", "utf8"),
);
const rows = data.levels;
const levels = [{ size: rows[0].size, profit: rows[0].profit, drop: 0 }, ...rows];
const lev = 20;
const slRoi = 225;

function calc(mode) {
  const sizes = levels.map((l) => l.size);
  const totalSize = sizes.reduce((a, b) => a + b, 0);
  const pricesBuy = levels.map((lv, i) => {
    const drop = i === 0 ? 0 : lv.drop;
    if (mode === "linear") return 1 - drop / lev / 100;
    if (mode === "compound") return 1 / (1 + drop / lev / 100);
    // price move = ROI/lev of previous? cumulative compound from first
    return Math.exp((-drop / lev / 100));
  });
  const avgBuy = sizes.reduce((s, sz, i) => s + sz * pricesBuy[i], 0) / totalSize;
  const slMark = avgBuy * (1 - slRoi / (lev * 100));
  const spotL = (1 - slMark) * 100;
  const roiFromFirst = ((1 - slMark) / 1) * lev * 100;
  const roiFromAvg = slRoi;
  const margin = totalSize / lev;
  const loss = margin * (slRoi / 100);
  // SELL
  const pricesSell = levels.map((lv, i) => {
    const drop = i === 0 ? 0 : lv.drop;
    if (mode === "linear") return 1 + drop / lev / 100;
    if (mode === "compound") return 1 + drop / lev / 100; // or 1*(1+drop/lev/100)
    return Math.exp(drop / lev / 100);
  });
  const avgSell = sizes.reduce((s, sz, i) => s + sz * pricesSell[i], 0) / totalSize;
  const slMarkS = avgSell * (1 + slRoi / (lev * 100));
  const spotS = (slMarkS - 1) * 100;
  return {
    mode,
    totalSize,
    levels: levels.length,
    avgBuy: +avgBuy.toFixed(6),
    avgSell: +avgSell.toFixed(6),
    spotL: +spotL.toFixed(2),
    spotS: +spotS.toFixed(2),
    roiFromFirst: +roiFromFirst.toFixed(2),
    loss: +loss.toFixed(2),
    margin: +margin.toFixed(2),
  };
}

// Also: SL from FIRST entry at lastDrop+extra, defense = last drop spot?
const last = levels[levels.length - 1].drop;
console.log("lastDrop", last, "levels", levels.length);
console.log(calc("linear"));
console.log(calc("compound"));

// Try: ROI defense = weighted avg of drop at fill + sl remaining
// Match 31.31: solve
// Target spotL 31.31, spotS 40.30, roi 35.59
function inv() {
  // If SL mark from first for L: spotL = 1 - 1/(1+x) 
}
// coin formula often: 
// long spot% = 1 - 1/(1 + roi/100) when lev=1; with lev: 1 - 1/(1+roi/(100*lev))?
const r = slRoi / 100;
console.log("simple spot", (r / lev) * 100);
console.log("compound lev", (1 - 1 / (1 + r / lev)) * 100);
console.log("compound no lev", (1 - 1 / (1 + r)) * 100);

// Defense after DCA: distance from entry0 to SL where SL is when POSITION roi hits -225
// position roi uses avg
// Another formula used in some bots:
// L_def = (1 - slMark/1)*100 where slMark from avg
// ROI_def = L_def * (1/avgBuy) ? 
const lin = calc("linear");
console.log("roi guess", lin.spotL * (1 / lin.avgBuy));
console.log("roi guess2", lin.spotL * lev / 20 * lin.avgBuy);
