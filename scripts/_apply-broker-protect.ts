/**
 * 열린 바스켓에 브로커 TP/SL 지정가 미리보기/적용.
 * DRY (기본): npx tsx --env-file=.env scripts/_apply-broker-protect.ts
 * APPLY:     APPLY=1 npx tsx --env-file=.env scripts/_apply-broker-protect.ts [login]
 */
import {
  basketExitPricesFromUsd,
  brokerProtectionMatches,
  clampBasketProtectForLegs,
  liveBasketTpSlUsd,
} from "../src/lib/dca1000";
import { resolveLiveTakeProfitPct, resolveLiveStopLossPct } from "../src/lib/table-logics";
import { fetchSnapshot, modifyPositionProtection, symbolsMatch } from "../src/lib/metaapi";
import { prisma } from "../src/lib/db";

async function main() {
  const apply = process.env.APPLY === "1";
  const loginFilter = process.argv[2] || process.env.LOGIN || "";

  const accounts = await prisma.brokerAccount.findMany({
    where: {
      metaApiAccountId: { not: null },
      status: { in: ["connected", "undeployed"] },
      ...(loginFilter ? { login: loginFilter } : {}),
      baskets: { some: { status: "open" } },
    },
    include: {
      baskets: { where: { status: "open" }, include: { legs: true } },
      symbolBots: true,
      user: { select: { email: true } },
    },
    take: loginFilter ? 5 : 8,
  });

  if (accounts.length === 0) {
    console.log("no open baskets");
    return;
  }

  for (const acc of accounts) {
    const metaId = String(acc.metaApiAccountId);
    console.log(
      `\n=== ${acc.login} ${acc.user?.email || ""} meta=${metaId.slice(0, 8)}… apply=${apply}`,
    );
    const snap = await fetchSnapshot(metaId);
    if (!snap.ok) {
      console.log("  snapshot fail:", snap.message);
      continue;
    }
    for (const basket of acc.baskets) {
      const dir = (basket.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
      const bot = acc.symbolBots.find(
        (b) =>
          symbolsMatch(b.symbol, basket.symbol) &&
          (b.dualDirection || (b.direction === "SELL" ? "SELL" : "BUY") === dir),
      );
      const logic = bot?.logic || "martin_9_068";
      const positions = snap.positions.filter(
        (p) => symbolsMatch(p.symbol, basket.symbol) && p.direction === dir,
      );
      if (positions.length === 0) {
        console.log(`  ${basket.symbol} ${dir}: no live positions`);
        continue;
      }
      const lots = positions.reduce((s, p) => s + p.lots, 0);
      const avg = positions.reduce((s, p) => s + p.lots * p.price, 0) / lots;
      const marginSum = positions.reduce(
        (s, p) => s + (typeof p.margin === "number" && p.margin > 0 ? p.margin : 0),
        0,
      );
      const tpPct = resolveLiveTakeProfitPct(logic, bot?.takeProfitPct);
      const slPct = resolveLiveStopLossPct(logic, bot?.stopLossPct);
      const live = liveBasketTpSlUsd({
        symbol: basket.symbol,
        lots,
        avgPrice: avg,
        takeProfitPct: tpPct,
        stopLossPct: slPct,
        brokerLeverage: snap.leverage || 500,
        brokerMarginSum: marginSum > 0 ? marginSum : null,
      });
      const pxRaw = basketExitPricesFromUsd({
        symbol: basket.symbol,
        direction: dir,
        avgPrice: avg,
        lots,
        takeProfitUsd: live.takeProfitUsd,
        stopLossUsd: live.stopLossUsd,
      });
      const clamped = clampBasketProtectForLegs({
        direction: dir,
        openPrices: positions.map((p) => p.price),
        takeProfit: pxRaw.takeProfit,
        stopLoss: pxRaw.stopLoss,
        point: pxRaw.point,
      });
      const px = { ...pxRaw, ...clamped };
      console.log(
        `  ${basket.symbol} ${dir} legs=${positions.length} lots=${lots.toFixed(2)} avg=${avg.toFixed(2)} tp$${live.takeProfitUsd} sl$${live.stopLossUsd}`,
      );
      console.log(`    target TP=${px.takeProfit} SL=${px.stopLoss}`);
      for (const p of positions) {
        const tpOk = brokerProtectionMatches({
          current: p.takeProfit,
          target: px.takeProfit,
          point: px.point,
        });
        const slOk = brokerProtectionMatches({
          current: p.stopLoss,
          target: px.stopLoss,
          point: px.point,
        });
        console.log(
          `    pos ${p.id} open=${p.price} brokerTP=${p.takeProfit ?? "-"} brokerSL=${p.stopLoss ?? "-"} ok=${tpOk && slOk}`,
        );
        if (apply && p.id && !(tpOk && slOk)) {
          const mod = await modifyPositionProtection({
            metaApiAccountId: metaId,
            positionId: p.id,
            takeProfit: px.takeProfit,
            stopLoss: px.stopLoss,
          });
          console.log(`      MODIFY ${mod.ok ? "ok" : mod.message}`);
        }
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
