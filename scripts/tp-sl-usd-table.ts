/**
 * Print Korean table: logic → 익절$ / 손절$ (defaults startLots=0.01)
 * Run: npx tsx scripts/tp-sl-usd-table.ts
 */
import { resolveTpSlUsd } from "../src/lib/dca1000";
import { LOGIC_OPTIONS } from "../src/lib/strategies";
import { defaultEditorPayload, tableLogicMeta } from "../src/lib/table-logics";

const symbols = ["EURUSD", "XAUUSD"] as const;

console.log("\n## 로직별 익절$/손절$ (startLots=0.01, 레버 1:500, 구 ROI 익절20%/손절225%)\n");

for (const sym of symbols) {
  console.log(`### ${sym}`);
  console.log("| 로직 | 익절 $ | 손절 $ | 시작증거금 $ |");
  console.log("|---|---:|---:|---:|");
  for (const logic of LOGIC_OPTIONS) {
    const meta = tableLogicMeta(logic.id);
    const def = defaultEditorPayload(logic.id);
    const usd = resolveTpSlUsd({
      symbol: sym,
      startLots: def.startLots ?? 0.01,
      takeProfitPct: def.takeProfitPct ?? meta.firstTpRoi ?? 20,
      stopLossPct: def.stopLossPct ?? 225,
    });
    console.log(
      `| ${logic.name} | +$${usd.takeProfitUsd.toFixed(2)} | -$${usd.stopLossUsd.toFixed(2)} | $${usd.marginUsd.toFixed(2)} |`,
    );
  }
  console.log("");
}

console.log("공식: 익절$ = startLots증거금 × (takeProfitPct/100)");
console.log("      손절$ = startLots증거금 × (stopLossPct/100)");
console.log("      증거금 = lots × contractSize × mid / 500");
