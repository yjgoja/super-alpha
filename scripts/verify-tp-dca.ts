import {
  mt5UsedMargin,
  mt5TpMoneyTarget,
  mt5FloatingRoiPct,
  mt5DcaAdverseRoi,
  mt5DcaAdversePct,
  triggerDropRoi,
  DCA1000_LEVELS,
  DCA1000_DEFAULT_SL_ROI,
  roiToPricePct,
  contractSizeForSymbol,
} from "../src/lib/dca1000";

const LEV = 500;
const TP_ROI = 20; // default table / UI

type Case = {
  name: string;
  symbol: string;
  entry: number;
  bid: number;
  ask: number;
  lots: number;
  pnl: number;
};

const cases: Case[] = [
  {
    name: "XAUUSD (MT5 screenshot)",
    symbol: "XAUUSD",
    entry: 4080.18,
    bid: 4060.28,
    ask: 4060.48,
    lots: 1,
    pnl: -1990,
  },
  {
    name: "EURUSD (MT5 screenshot)",
    symbol: "EURUSD",
    entry: 1.14491,
    bid: 1.14288,
    ask: 1.14298,
    lots: 1,
    pnl: -203,
  },
];

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("PASS:", msg);
  }
}

function moneyAtRoi(margin: number, roi: number) {
  return +(margin * (roi / 100)).toFixed(2);
}

function priceForLossRoi(
  direction: "BUY",
  entry: number,
  lossRoi: number,
  lev: number,
) {
  // price% = ROI / lev
  const pct = lossRoi / lev / 100;
  return +(entry * (1 - pct)).toFixed(direction === "BUY" ? 5 : 2);
}

console.log("============================================================");
console.log(" SUPER ALPHA — LIVE LOGIC VERIFICATION");
console.log("============================================================\n");

console.log("【공통 정의】");
console.log("- 계좌 레버: 1:" + LEV + " (MT5_BROKER_LEVERAGE_DEFAULT)");
console.log("- 익절 ROI: 손익 ÷ 사용증거금 × 100  ≥  tpRoi%");
console.log("- 익절 $: 사용증거금 × (tpRoi/100)");
console.log("- 물타기: max(손실ROI, 가격역행%×레버) ≥ 표 drop ROI");
console.log("- 손절: 가격역행% ≥ 손절ROI÷20  (표/코인 레버20 환산)");
console.log("- 틱당 물타기 최대: 8회차");
console.log("- 기본 전략표: dubai_bruno_313 (L0..L998, drop 누적 ROI)");
console.log("- 기본 익절 ROI: " + TP_ROI + "% / 기본 손절 ROI: " + DCA1000_DEFAULT_SL_ROI + "%");
console.log("");

for (const c of cases) {
  const margin = mt5UsedMargin({
    symbol: c.symbol,
    lots: c.lots,
    avgPrice: c.entry,
    brokerLeverage: LEV,
  });
  const tpMoney = mt5TpMoneyTarget({
    symbol: c.symbol,
    lots: c.lots,
    avgPrice: c.entry,
    tpRoiPct: TP_ROI,
    brokerLeverage: LEV,
  });
  const floatRoi = mt5FloatingRoiPct(c.pnl, margin);
  const lossRoi = Math.max(0, -floatRoi);
  const advPx = mt5DcaAdversePct("BUY", c.entry, c.bid, c.ask);
  const adv500 = mt5DcaAdverseRoi("BUY", c.entry, c.bid, c.ask, LEV);
  const adv20 = mt5DcaAdverseRoi("BUY", c.entry, c.bid, c.ask, 20);
  const adverse = Math.max(lossRoi, adv500);

  let filled = 0;
  let actions = 0;
  const fired: number[] = [];
  while (filled + 1 < DCA1000_LEVELS.length && actions < 8) {
    const next = filled + 1;
    const need = triggerDropRoi(next, DCA1000_LEVELS);
    if (adverse < need) break;
    fired.push(need);
    filled = next;
    actions += 1;
  }

  const nextNeed =
    filled + 1 < DCA1000_LEVELS.length
      ? triggerDropRoi(filled + 1, DCA1000_LEVELS)
      : null;

  const slPricePct = roiToPricePct(DCA1000_DEFAULT_SL_ROI); // /20
  const slPrice = +(c.entry * (1 - slPricePct / 100)).toFixed(
    c.symbol.startsWith("XAU") ? 2 : 5,
  );

  console.log("------------------------------------------------------------");
  console.log(c.name);
  console.log("------------------------------------------------------------");
  console.log(
    JSON.stringify(
      {
        contractSize: contractSizeForSymbol(c.symbol),
        lots: c.lots,
        entry: c.entry,
        nowBid: c.bid,
        usedMargin: +margin.toFixed(2),
        tpRoiPct: TP_ROI,
        takeProfitAt_USD: tpMoney,
        takeProfitAt_priceApprox: priceForLossRoi("BUY", c.entry, -TP_ROI, LEV), // wrong sign helper
        // BUY TP: price rises by ROI/lev
        takeProfitPrice_BUY: +(c.entry * (1 + TP_ROI / LEV / 100)).toFixed(
          c.symbol.startsWith("XAU") ? 2 : 5,
        ),
        currentPnl: c.pnl,
        currentLossRoi: +lossRoi.toFixed(2),
        priceAdversePct: +advPx.toFixed(4),
        OLD_roi_x20: +adv20.toFixed(2),
        NEW_roi_x500: +adv500.toFixed(2),
        NEW_adverseUsed: +adverse.toFixed(2),
        firstDcaDropRoi: triggerDropRoi(1, DCA1000_LEVELS),
        firstDcaAt_USD_loss: moneyAtRoi(margin, 10),
        firstDcaAt_price: priceForLossRoi(
          "BUY",
          c.entry,
          10,
          LEV,
        ),
        OLD_wouldDca: adv20 >= 10,
        NEW_wouldDca: adverse >= 10,
        dcaThisTick: actions,
        dcaDropRoisFired: fired,
        nextDropRoiAfterTick: nextNeed,
        stopLossRoi: DCA1000_DEFAULT_SL_ROI,
        stopLossPricePct: slPricePct,
        stopLossPrice_BUY: slPrice,
        wouldStopLossNow: advPx >= slPricePct,
      },
      null,
      2,
    ),
  );
  console.log("");

  assert(adverse >= 10, c.name + " NEW logic DCA L1");
  assert(adv20 < 10, c.name + " OLD x20 would NOT DCA (explains bug)");
  assert(actions === 8, c.name + " catches up 8 levels/tick");
  assert(c.pnl < tpMoney, c.name + " not at TP (in loss)");
}

// Unique early DCA thresholds for 1 lot XAU / EUR
const xauM = mt5UsedMargin({
  symbol: "XAUUSD",
  lots: 1,
  avgPrice: 4080.18,
  brokerLeverage: LEV,
});
const eurM = mt5UsedMargin({
  symbol: "EURUSD",
  lots: 1,
  avgPrice: 1.14491,
  brokerLeverage: LEV,
});

console.log("============================================================");
console.log(" 물타기 구간표 (두바이부르노 기본표 · 1로트 · 레버500)");
console.log(" drop ROI 도달 시 해당 회차 진입 (누적 첫진입 기준)");
console.log("============================================================");
console.log(
  "회차 | dropROI | 가격역행% | XAU손실$ | EUR손실$ | XAU진입가(대략) | EUR진입가(대략)",
);

let last = -1;
for (let i = 1; i <= 40; i++) {
  const d = triggerDropRoi(i, DCA1000_LEVELS);
  if (d === last) continue;
  last = d;
  const px = d / LEV;
  const xauP = priceForLossRoi("BUY", 4080.18, d, LEV);
  const eurP = priceForLossRoi("BUY", 1.14491, d, LEV);
  console.log(
    [
      String(i).padStart(4),
      String(d).padStart(7),
      (px.toFixed(4) + "%").padStart(10),
      ("$" + moneyAtRoi(xauM, d)).padStart(9),
      ("$" + moneyAtRoi(eurM, d)).padStart(9),
      String(xauP).padStart(16),
      String(eurP).padStart(16),
    ].join(" | "),
  );
}

console.log("\n============================================================");
console.log(" 익절 기준 (ROI " + TP_ROI + "% · 1로트 · 레버500)");
console.log("============================================================");
console.log({
  XAUUSD: {
    margin: +xauM.toFixed(2),
    tpMoney: mt5TpMoneyTarget({
      symbol: "XAUUSD",
      lots: 1,
      avgPrice: 4080.18,
      tpRoiPct: TP_ROI,
      brokerLeverage: LEV,
    }),
    tpPrice: +(4080.18 * (1 + TP_ROI / LEV / 100)).toFixed(2),
  },
  EURUSD: {
    margin: +eurM.toFixed(2),
    tpMoney: mt5TpMoneyTarget({
      symbol: "EURUSD",
      lots: 1,
      avgPrice: 1.14491,
      tpRoiPct: TP_ROI,
      brokerLeverage: LEV,
    }),
    tpPrice: +(1.14491 * (1 + TP_ROI / LEV / 100)).toFixed(5),
  },
});

console.log("\n0.01로트 환산 (참고):");
console.log({
  XAU_0_01: {
    margin: +mt5UsedMargin({
      symbol: "XAUUSD",
      lots: 0.01,
      avgPrice: 4080.18,
      brokerLeverage: LEV,
    }).toFixed(2),
    tpMoney: mt5TpMoneyTarget({
      symbol: "XAUUSD",
      lots: 0.01,
      avgPrice: 4080.18,
      tpRoiPct: TP_ROI,
      brokerLeverage: LEV,
    }),
  },
  EUR_0_01: {
    margin: +mt5UsedMargin({
      symbol: "EURUSD",
      lots: 0.01,
      avgPrice: 1.14491,
      brokerLeverage: LEV,
    }).toFixed(2),
    tpMoney: mt5TpMoneyTarget({
      symbol: "EURUSD",
      lots: 0.01,
      avgPrice: 1.14491,
      tpRoiPct: TP_ROI,
      brokerLeverage: LEV,
    }),
  },
});

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nAll assertions passed.");
