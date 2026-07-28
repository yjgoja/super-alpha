/**
 * 공개 로직 × GBPUSD/XAUUSD 요약표
 * 방어폭 · 회차별 익절$ · 전체 소진 후 손절$
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  MT5_BROKER_LEVERAGE_DEFAULT,
  MT5_REF_MID,
  contractSizeForSymbol,
  liveBasketTpSlUsd,
} from "../src/lib/dca1000";
import {
  getMartin9Defense,
  getTableLevels,
  isBulkLogic,
  lotsForLogicLevel,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";
import { PRIMARY_LOGIC_IDS, logicLabel } from "../src/lib/strategies";

const LEV = MT5_BROKER_LEVERAGE_DEFAULT;
const START = 0.01;
const SYMBOLS = ["GBPUSD", "XAUUSD"] as const;

function findPrice(
  entries: Array<{ lots: number; price: number }>,
  targetRoi: number,
  cs: number,
  mid: number,
) {
  let lo = mid * 0.05;
  let hi = mid * 2;
  let best = mid;
  for (let k = 0; k < 80; k++) {
    const p = (lo + hi) / 2;
    const margin = entries.reduce((s, e) => s + (e.lots * cs * e.price) / LEV, 0);
    const pnl = entries.reduce((s, e) => s + e.lots * cs * (p - e.price), 0);
    const roi = margin > 0 ? (pnl / margin) * 100 : 0;
    best = p;
    if (roi > targetRoi) hi = p;
    else lo = p;
  }
  return best;
}

function chartDefensePct(logic: string, symbol: string) {
  const defense = getMartin9Defense(logic);
  if (defense) return defense.chartPct;
  // sustained: MT5 path to SL
  const mid = MT5_REF_MID[symbol] ?? (symbol.startsWith("XAU") ? 4050 : 1.27);
  const cs = contractSizeForSymbol(symbol);
  const levels = getTableLevels(logic);
  const slRoi = resolveLiveStopLossPct(logic);
  const equalLots = isBulkLogic(logic);
  const mult = defense ? 2 : isBulkLogic(logic) ? 1 : 2;
  const entries = [{ lots: START, price: mid }];
  for (let i = 1; i < levels.length; i++) {
    const drop = levels[i]!.drop;
    if (drop >= slRoi) break;
    const price = findPrice(entries, -drop, cs, mid);
    const lots = equalLots
      ? START
      : lotsForLogicLevel(logic, i, START, mult, levels[i]!.size, levels[i]!.lots);
    entries.push({ lots, price });
  }
  const slP = findPrice(entries, -slRoi, cs, mid);
  return Math.round(((mid - slP) / mid) * 100000) / 1000;
}

function levelSheet(logic: string, symbol: string) {
  const mid = MT5_REF_MID[symbol] ?? (symbol.startsWith("XAU") ? 4050 : 1.27);
  const cs = contractSizeForSymbol(symbol);
  const levels = getTableLevels(logic, isBulkLogic(logic) ? 1 : 2);
  const slRoi = resolveLiveStopLossPct(logic);
  const equalLots = isBulkLogic(logic);
  const mult = isBulkLogic(logic) ? 1 : 2;

  const entries: Array<{ lots: number; price: number }> = [];
  const rows: Array<{
    level: number;
    lotsCum: number;
    drop: number;
    tpRoi: number;
    tpUsd: number;
    slUsd: number;
  }> = [];

  for (let i = 0; i < levels.length; i++) {
    const drop = levels[i]!.drop;
    if (i > 0 && drop >= slRoi) break;
    const price =
      i === 0 ? mid : findPrice(entries, -drop, cs, mid);
    const lots = equalLots
      ? START
      : lotsForLogicLevel(logic, i, START, mult, levels[i]!.size, levels[i]!.lots);
    entries.push({ lots, price });
    const cumLots = entries.reduce((s, e) => s + e.lots, 0);
    const avg =
      entries.reduce((s, e) => s + e.lots * e.price, 0) / cumLots;
    const tpRoi =
      isBulkLogic(logic)
        ? levels[i]!.profit
        : resolveLiveTakeProfitPct(logic);
    const live = liveBasketTpSlUsd({
      symbol,
      lots: cumLots,
      avgPrice: avg,
      takeProfitPct: tpRoi,
      stopLossPct: slRoi,
      brokerLeverage: LEV,
    });
    rows.push({
      level: i,
      lotsCum: Math.round(cumLots * 100) / 100,
      drop: i === 0 ? 0 : drop,
      tpRoi,
      tpUsd: live.takeProfitUsd,
      slUsd: live.stopLossUsd,
    });
  }

  const last = rows[rows.length - 1]!;
  return {
    logic,
    label: logicLabel(logic),
    symbol,
    chartPct: chartDefensePct(logic, symbol),
    slRoi,
    filled: rows.length,
    endSlUsd: last.slUsd,
    rows,
  };
}

const outDir = join("scripts", "out");
mkdirSync(outDir, { recursive: true });

const all = PRIMARY_LOGIC_IDS.flatMap((id) =>
  SYMBOLS.map((sym) => levelSheet(id, sym)),
);

let md = `# 로직별 · 종목별 익절/손절 요약

기준: 시작로트 **0.01** · 브로커 레버 **1:${LEV}** · 참조가 GBP $${MT5_REF_MID.GBPUSD} / XAU $${MT5_REF_MID.XAUUSD}

- 전 공개 마틴(스피드·2배·3배·안정·코어·타임): **익절 10%**
- 지속: 표 profit **절반** · 손절 −351%
- 손절 ROI / 방어폭 / 물타기 drop 은 기존 유지

`;

for (const sym of SYMBOLS) {
  md += `\n## ${sym}\n\n`;
  md += `| 로직 | 방어폭 | 끝까지 손절금 | 손절 ROI |\n`;
  md += `|---|---:|---:|---:|\n`;
  for (const s of all.filter((x) => x.symbol === sym)) {
    md += `| ${s.label} | ${s.chartPct}% | $${s.endSlUsd.toLocaleString()} | −${s.slRoi}% |\n`;
  }

  for (const s of all.filter((x) => x.symbol === sym)) {
    md += `\n### ${s.label}\n\n`;
    md += `방어폭 **${s.chartPct}%** · 채움 ${s.filled}회 · 끝 손절 **$${s.endSlUsd.toLocaleString()}** (−${s.slRoi}%)\n\n`;
    md += `| 회차 | 누적랏 | 물타기ROI | 익절ROI | 익절$ | (참고)해당시점손절$ |\n`;
    md += `|---:|---:|---:|---:|---:|---:|\n`;
    // bulk 지속은 회차 많음 → 티어 샘플 + 마지막
    const rows =
      s.rows.length > 20
        ? [
            ...s.rows.filter((r) =>
              [0, 1, 2, 4, 7, 11, 17, 26, 40, 61, 92, 139, 181, 209, 251, 301, 333].includes(
                r.level,
              ),
            ),
            s.rows[s.rows.length - 1]!,
          ].filter(
            (r, i, a) => a.findIndex((x) => x.level === r.level) === i,
          )
        : s.rows;
    for (const r of rows) {
      md += `| L${r.level} | ${r.lotsCum} | ${r.drop || "—"}% | ${r.tpRoi}% | $${r.tpUsd} | $${r.slUsd} |\n`;
    }
  }
}

const mdPath = join(outDir, "logic-tp-sl-by-symbol.md");
const jsonPath = join(outDir, "logic-tp-sl-by-symbol.json");
writeFileSync(mdPath, md, "utf8");
writeFileSync(jsonPath, JSON.stringify(all, null, 2), "utf8");
console.log("WROTE", mdPath);
console.log("WROTE", jsonPath);

// compact console summary
for (const sym of SYMBOLS) {
  console.log(`\n=== ${sym} ===`);
  for (const s of all.filter((x) => x.symbol === sym)) {
    const tpLine = s.rows
      .slice(0, Math.min(9, s.rows.length))
      .map((r) => `L${r.level}:$${r.tpUsd}`)
      .join(" ");
    console.log(
      `${s.label} | 방어 ${s.chartPct}% | 끝손절 $${s.endSlUsd} | TP[${tpLine}${s.rows.length > 9 ? " …" : ""}]`,
    );
  }
}
