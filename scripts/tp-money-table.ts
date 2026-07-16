/**
 * Print TP money tables for all logics.
 * Run: npx tsx scripts/tp-money-table.ts
 */
import { estimateTpMoneyForLevels, MT5_REF_MID, mt5TpMoneyTarget } from "../src/lib/dca1000";
import { getTableLevels, TABLE_LOGIC_IDS, tableLogicMeta } from "../src/lib/table-logics";

const START = 0.01;
const DEPTHS = [0, 4, 9, 19, 49, 99]; // 0-based filledThrough

const labels: Record<string, string> = {
  martin_9: "마틴9",
  martin_10: "마틴10",
  martin_11: "마틴11",
  martin_12: "마틴12",
  dubai_bruno_313: "두바이부르노313",
};

function row(symbol: string, mid: number) {
  console.log(`\n=== ${symbol} @ ${mid} · startLots=${START} · 전략레버 20x ===`);
  console.log(
    "로직".padEnd(18),
    "회차".padStart(6),
    "로트".padStart(8),
    "익절ROI%".padStart(10),
    "익절$".padStart(12),
  );
  for (const id of TABLE_LOGIC_IDS) {
    const levels = getTableLevels(id);
    const meta = tableLogicMeta(id);
    const depths = [...DEPTHS.filter((d) => d < levels.length), levels.length - 1];
    const uniq = [...new Set(depths)];
    for (const d of uniq) {
      const e = estimateTpMoneyForLevels({
        symbol,
        levels,
        filledThrough: d,
        startLots: START,
        refMid: mid,
      });
      console.log(
        (labels[id] || id).padEnd(18),
        String(e.levelsUsed).padStart(6),
        e.totalLots.toFixed(2).padStart(8),
        String(e.tpRoiPct).padStart(10),
        e.tpMoney.toFixed(2).padStart(12),
      );
    }
    // also L0 with fixed ROI 20 for clarity
    const l0 = mt5TpMoneyTarget({
      symbol,
      lots: 0.01,
      avgPrice: mid,
      tpRoiPct: meta.firstTpRoi,
    });
    console.log(
      `${(labels[id] || id).padEnd(16)} L0고정`,
      "1".padStart(6),
      "0.01".padStart(8),
      String(meta.firstTpRoi).padStart(10),
      l0.toFixed(2).padStart(12),
    );
  }
}

row("EURUSD", 1.145);
row("XAUUSD", 4080);

// 1 lot gold example (user position scale)
console.log("\n=== 참고: XAU 1.00 lot @4080 ROI20 ===");
console.log(
  mt5TpMoneyTarget({ symbol: "XAUUSD", lots: 1, avgPrice: 4080, tpRoiPct: 20 }).toFixed(2),
);
console.log("=== 참고: XAU 0.01 lot @4080 ROI20 ===");
console.log(
  mt5TpMoneyTarget({ symbol: "XAUUSD", lots: 0.01, avgPrice: 4080, tpRoiPct: 20 }).toFixed(2),
);
