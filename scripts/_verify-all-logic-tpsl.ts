/**
 * 전 로직 익절·손절·물타기 정확성 검증 + 회차별 금액표 생성
 *
 * 실행: npx tsx scripts/_verify-all-logic-tpsl.ts
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DCA1000_DEFAULT_SL_ROI,
  MT5_BROKER_LEVERAGE_DEFAULT,
  MT5_REF_MID,
  liveBasketTpSlUsd,
  mt5UsedMargin,
  shouldTriggerDcaRoi,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
} from "../src/lib/dca1000";
import {
  getMartin9Defense,
  getTableLevels,
  lotsForLogicLevel,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";
import { PRIMARY_LOGIC_IDS, logicLabel, normalizeLogicId } from "../src/lib/strategies";

const SYMBOLS = ["EURUSD", "GBPUSD", "AUDUSD", "XAUUSD"] as const;
const START_LOTS = 0.01;
const LEV = MT5_BROKER_LEVERAGE_DEFAULT;
const EPS = 1e-9;

type Fail = { name: string; detail: string };
const fails: Fail[] = [];
const passes: string[] = [];

function assert(name: string, cond: boolean, detail = "") {
  if (cond) passes.push(name);
  else fails.push({ name, detail });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function marginAt(symbol: string, lots: number, price: number) {
  return mt5UsedMargin({
    symbol,
    lots,
    avgPrice: price,
    brokerLeverage: LEV,
  });
}

function decideAtRoi(opts: {
  margin: number;
  tpRoi: number;
  slRoi: number;
  dropRoi: number | null;
  roi: number;
}) {
  const pnl = (opts.roi / 100) * opts.margin;
  const live = {
    takeProfitUsd: round2(opts.margin * (opts.tpRoi / 100)),
    stopLossUsd: round2(opts.margin * (opts.slRoi / 100)),
  };
  const tp = shouldTriggerTakeProfit({
    pnl,
    takeProfitUsd: live.takeProfitUsd,
    usedMargin: opts.margin,
    tpRoiPct: opts.tpRoi,
  });
  const sl = shouldTriggerStopLossUsd({
    pnl,
    stopLossUsd: live.stopLossUsd,
    usedMargin: opts.margin,
    stopLossRoiPct: opts.slRoi,
  });
  const dca =
    opts.dropRoi != null && opts.dropRoi > 0
      ? shouldTriggerDcaRoi({
          pnl,
          usedMargin: opts.margin,
          dropRoiPct: opts.dropRoi,
        })
      : { hit: false, basketRoi: opts.roi, dropRoiPct: 0, lossUsd: 0 };
  // 엔진 순서: TP → SL → DCA
  let action: "tp" | "sl" | "dca" | "hold" = "hold";
  if (tp.hit) action = "tp";
  else if (sl.hit) action = "sl";
  else if (dca.hit) action = "dca";
  return { action, tp, sl, dca, pnl: round2(pnl) };
}

type LevelRow = {
  level: number;
  lotsThis: number;
  lotsCum: number;
  drop: number;
  profitRoi: number;
  nextDcaRoi: number | null;
  margin: number;
  tpUsd: number;
  slUsd: number;
  slRoi: number;
};

function buildLevelSheet(logic: string, symbol: string, startLots: number) {
  const id = normalizeLogicId(logic);
  const mult = id.startsWith("martin_9") ? 2 : 1;
  const levels = getTableLevels(id, mult);
  const slRoi = resolveLiveStopLossPct(id, 9999);
  const mid = MT5_REF_MID[symbol] ?? MT5_REF_MID.EURUSD;
  const rows: LevelRow[] = [];
  let lotsCum = 0;
  for (let i = 0; i < levels.length; i++) {
    const lotsThis = lotsForLogicLevel(
      id,
      i,
      startLots,
      mult,
      levels[i].size,
      levels[i].lots,
    );
    lotsCum = round2(lotsCum + lotsThis);
    const tpRoi =
      id === "dubai_bruno_313"
        ? levels[i].profit
        : resolveLiveTakeProfitPct(id, 20);
    const next = levels[i + 1];
    const nextDcaRoi = next && next.drop > 0 ? next.drop : null;
    const live = liveBasketTpSlUsd({
      symbol,
      lots: lotsCum,
      avgPrice: mid,
      takeProfitPct: tpRoi,
      stopLossPct: slRoi,
      brokerLeverage: LEV,
    });
    rows.push({
      level: i,
      lotsThis,
      lotsCum,
      drop: levels[i].drop,
      profitRoi: tpRoi,
      nextDcaRoi,
      margin: live.marginUsd,
      tpUsd: live.takeProfitUsd,
      slUsd: live.stopLossUsd,
      slRoi,
    });
  }
  return { id, slRoi, mid, rows, defense: getMartin9Defense(id) };
}

function testTriggers() {
  const margin = 100;
  // TP boundary
  assert(
    "TP hits at +20%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 10, roi: 20 }).action ===
      "tp",
  );
  assert(
    "TP hold at +19.9%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 10, roi: 19.9 })
      .action === "hold",
  );
  // SL boundary — must beat DCA when both would qualify
  assert(
    "SL hits at -225%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 40, roi: -225 })
      .action === "sl",
  );
  assert(
    "SL hold at -224%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 40, roi: -224 })
      .action === "hold" ||
      decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 40, roi: -224 })
        .action === "dca",
  );
  // When ROI = -230 and SL=225, SL wins over DCA(drop 230)
  assert(
    "SL priority over deeper DCA",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 230, roi: -230 })
      .action === "sl",
  );
  // DCA
  assert(
    "DCA hits at -10%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 10, roi: -10 })
      .action === "dca",
  );
  assert(
    "DCA hold at -9.9%",
    decideAtRoi({ margin, tpRoi: 20, slRoi: 225, dropRoi: 10, roi: -9.9 })
      .action === "hold",
  );
  // TP priority over everything
  assert(
    "TP priority even if SL/DCA also true (impossible ROI but $ path)",
    shouldTriggerTakeProfit({
      pnl: 20,
      takeProfitUsd: 20,
      usedMargin: 100,
      tpRoiPct: 20,
    }).hit,
  );
}

function testResolvers() {
  assert(
    "스피드 ignores stored 1250",
    resolveLiveStopLossPct("martin_9_068", 1250) === 225,
  );
  assert(
    "스피드 alias martin_9 → 225",
    resolveLiveStopLossPct("martin_9", 1250) === 225,
  );
  assert(
    "안정 SL 1170.3",
    Math.abs(resolveLiveStopLossPct("martin_9_35", 225) - 1170.3) < EPS,
  );
  assert(
    "코어 SL 2191.7",
    Math.abs(resolveLiveStopLossPct("martin_9_65", 225) - 2191.7) < EPS,
  );
  assert(
    "지속 ignores 1250 → 225",
    resolveLiveStopLossPct("dubai_bruno_313", 1250) === DCA1000_DEFAULT_SL_ROI,
  );
  assert(
    "custom keeps stored",
    resolveLiveStopLossPct("custom", 999) === 999,
  );
  assert(
    "스피드 TP locked 20",
    resolveLiveTakeProfitPct("martin_9_068", 50) === 20,
  );
}

function testMartinDrops() {
  const speed = getTableLevels("martin_9_068", 2);
  assert("스피드 9회차", speed.length === 9);
  assert(
    "스피드 drops",
    JSON.stringify(speed.map((l) => l.drop)) ===
      JSON.stringify([0, 10, 20, 20, 30, 30, 30, 40, 40]),
  );
  const stab = getTableLevels("martin_9_35", 2);
  assert(
    "안정 drops",
    JSON.stringify(stab.map((l) => l.drop)) ===
      JSON.stringify([0, 52, 104, 104, 156, 156, 156, 208, 208]),
  );
  const core = getTableLevels("martin_9_65", 2);
  assert(
    "코어 drops",
    JSON.stringify(core.map((l) => l.drop)) ===
      JSON.stringify([0, 97, 195, 195, 292, 292, 292, 390, 390]),
  );
}

function testLevelMoneyConsistency(logic: string, symbol: string) {
  const sheet = buildLevelSheet(logic, symbol, START_LOTS);
  for (const r of sheet.rows) {
    const expectTp = round2(r.margin * (r.profitRoi / 100));
    const expectSl = round2(r.margin * (r.slRoi / 100));
    assert(
      `${logic}/${symbol}/L${r.level} TP$`,
      Math.abs(r.tpUsd - expectTp) < 0.02,
      `got ${r.tpUsd} expect ${expectTp}`,
    );
    assert(
      `${logic}/${symbol}/L${r.level} SL$`,
      Math.abs(r.slUsd - expectSl) < 0.02,
      `got ${r.slUsd} expect ${expectSl}`,
    );
    // 경계 시뮬
    const atTp = decideAtRoi({
      margin: r.margin,
      tpRoi: r.profitRoi,
      slRoi: r.slRoi,
      dropRoi: r.nextDcaRoi,
      roi: r.profitRoi,
    });
    assert(`${logic}/${symbol}/L${r.level} TP trigger`, atTp.action === "tp");
    const atSl = decideAtRoi({
      margin: r.margin,
      tpRoi: r.profitRoi,
      slRoi: r.slRoi,
      dropRoi: r.nextDcaRoi,
      roi: -r.slRoi,
    });
    assert(`${logic}/${symbol}/L${r.level} SL trigger`, atSl.action === "sl");
    if (r.nextDcaRoi != null && r.nextDcaRoi < r.slRoi) {
      const atDca = decideAtRoi({
        margin: r.margin,
        tpRoi: r.profitRoi,
        slRoi: r.slRoi,
        dropRoi: r.nextDcaRoi,
        roi: -r.nextDcaRoi,
      });
      assert(
        `${logic}/${symbol}/L${r.level} DCA trigger`,
        atDca.action === "dca",
        `action=${atDca.action}`,
      );
    }
    if (r.nextDcaRoi != null && r.nextDcaRoi >= r.slRoi) {
      // 다음 물타기 drop이 손절 ROI 이상이면 SL이 먼저
      const atDeep = decideAtRoi({
        margin: r.margin,
        tpRoi: r.profitRoi,
        slRoi: r.slRoi,
        dropRoi: r.nextDcaRoi,
        roi: -r.nextDcaRoi,
      });
      assert(
        `${logic}/${symbol}/L${r.level} SL before deep DCA`,
        atDeep.action === "sl",
        `action=${atDeep.action}`,
      );
    }
  }
}

function testMartinLotLadder() {
  const lots = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
    lotsForLogicLevel("martin_9_068", i, 0.01, 2, 10 * 2 ** i),
  );
  assert(
    "마틴 로트 2배",
    JSON.stringify(lots) ===
      JSON.stringify([0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56]),
  );
  const eq = [0, 1, 2, 3].map((i) =>
    lotsForLogicLevel("dubai_bruno_313", i, 0.01, 1, 10),
  );
  assert(
    "313 동일로트",
    JSON.stringify(eq) === JSON.stringify([0.01, 0.01, 0.01, 0.01]),
  );
}

function dubaiTierSummary() {
  const levels = getTableLevels("dubai_bruno_313");
  const tiers: Array<{
    fromLevel: number;
    toLevel: number;
    drop: number;
    profit: number;
    count: number;
  }> = [];
  let i = 0;
  while (i < levels.length) {
    const drop = levels[i].drop;
    const profit = levels[i].profit;
    let j = i;
    while (
      j < levels.length &&
      levels[j].drop === drop &&
      levels[j].profit === profit
    ) {
      j++;
    }
    tiers.push({
      fromLevel: i,
      toLevel: j - 1,
      drop,
      profit,
      count: j - i,
    });
    i = j;
  }
  return tiers;
}

function main() {
  testResolvers();
  testTriggers();
  testMartinDrops();
  testMartinLotLadder();

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    startLots: START_LOTS,
    leverage: LEV,
    rule: {
      basketRoi: "pnl / usedMargin * 100",
      tp: "BasketROI >= profitRoi%  OR  pnl >= margin*profitRoi/100",
      sl: "BasketROI <= -slRoi%  OR  pnl <= -margin*slRoi/100",
      dca: "BasketROI <= -nextLevel.drop%",
      order: "TP → SL → DCA (1 DCA/tick)",
    },
    logics: {} as Record<string, unknown>,
  };

  for (const logic of PRIMARY_LOGIC_IDS) {
    for (const symbol of SYMBOLS) {
      testLevelMoneyConsistency(logic, symbol);
    }
    const xau = buildLevelSheet(logic, "XAUUSD", START_LOTS);
    const eurusd = buildLevelSheet(logic, "EURUSD", START_LOTS);
    const bySymbol: Record<string, ReturnType<typeof buildLevelSheet>> = {};
    for (const s of SYMBOLS) bySymbol[s] = buildLevelSheet(logic, s, START_LOTS);

    (report.logics as Record<string, unknown>)[logic] = {
      name: logicLabel(logic),
      slRoi: xau.slRoi,
      chartPct: xau.defense?.chartPct ?? null,
      takeProfitMode:
        logic === "dubai_bruno_313" ? "per-level profit tier" : "fixed 20%",
      lotMode: logic.startsWith("martin_9") ? "startLots × 2^level" : "equal startLots",
      levelCount: xau.rows.length,
      tiers: logic === "dubai_bruno_313" ? dubaiTierSummary() : null,
      // 전체 회차 (XAU 기준 상세) + 심볼별 L0 요약
      levelsXau: xau.rows,
      l0BySymbol: Object.fromEntries(
        SYMBOLS.map((s) => {
          const r = bySymbol[s].rows[0];
          return [
            s,
            {
              margin: r.margin,
              tpUsd: r.tpUsd,
              slUsd: r.slUsd,
              nextDcaRoi: r.nextDcaRoi,
            },
          ];
        }),
      ),
      // 전 심볼 전 회차
      levelsBySymbol: Object.fromEntries(
        SYMBOLS.map((s) => [s, bySymbol[s].rows]),
      ),
      eurusdL0: eurusd.rows[0],
    };
  }

  const outDir = join(process.cwd(), "scripts", "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "logic-tpsl-verify.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== VERIFY RESULT ===");
  console.log("PASS", passes.length);
  console.log("FAIL", fails.length);
  for (const f of fails.slice(0, 40)) {
    console.log("FAIL:", f.name, f.detail);
  }
  if (fails.length > 40) console.log(`... +${fails.length - 40} more`);
  console.log("report:", outPath);

  // 콘솔 요약표 (XAU 0.01)
  for (const logic of PRIMARY_LOGIC_IDS) {
    const sheet = buildLevelSheet(logic, "XAUUSD", START_LOTS);
    console.log(`\n## ${logicLabel(logic)} (${logic}) SL=${sheet.slRoi}%`);
    const show =
      logic === "dubai_bruno_313"
        ? sheet.rows.filter(
            (r, idx, arr) =>
              idx === 0 ||
              r.profitRoi !== arr[idx - 1].profitRoi ||
              r.drop !== arr[idx - 1].drop ||
              idx === arr.length - 1 ||
              (r.nextDcaRoi != null && r.nextDcaRoi >= sheet.slRoi),
          )
        : sheet.rows;
    for (const r of show) {
      console.log(
        `  L${String(r.level).padStart(3)} lots=${r.lotsThis} cum=${r.lotsCum}` +
          ` drop=${r.drop} tpRoi=${r.profitRoi}%` +
          ` margin=$${r.margin} TP=$${r.tpUsd} SL=$${r.slUsd}` +
          ` nextDca=${r.nextDcaRoi ?? "-"}%`,
      );
    }
  }

  if (fails.length > 0) process.exit(1);
}

main();
