/**
 * 라이브 전수: 공개 프리셋 SL/TP DB·런타임 resolver 일치 + 오픈바스켓 손절선
 */
import { prisma } from "../src/lib/db";
import {
  DCA1000_DEFAULT_SL_ROI,
  MT5_BROKER_LEVERAGE_DEFAULT,
  liveBasketTpSlUsd,
  mt5FloatingRoiPct,
  shouldTriggerStopLossUsd,
  shouldTriggerTakeProfit,
} from "../src/lib/dca1000";
import {
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";
import { normalizeLogicId, PRIMARY_LOGIC_IDS } from "../src/lib/strategies";
import { ensureCloudLive, fetchSnapshot } from "../src/lib/metaapi";

async function main() {
  const bots = await prisma.symbolBot.findMany({
    include: { account: { include: { user: { select: { email: true } } } } },
  });

  let mismatch = 0;
  let fixed = 0;
  for (const b of bots) {
    const logic = normalizeLogicId(b.logic);
    if (logic === "custom") continue;
    if (!(PRIMARY_LOGIC_IDS as readonly string[]).includes(logic) && logic !== "martin_9")
      continue;
    const wantSl = resolveLiveStopLossPct(logic, b.stopLossPct);
    const wantTp = resolveLiveTakeProfitPct(logic, b.takeProfitPct);
    const needLogic = b.logic !== logic;
    const needSl = Math.abs(b.stopLossPct - wantSl) > 0.01;
    const needTp =
      logic.startsWith("martin_9_") && Math.abs(b.takeProfitPct - wantTp) > 0.01;
    if (needLogic || needSl || needTp) {
      mismatch++;
      console.log(
        `FIX ${b.account.user.email} ${b.symbol} ${b.direction}: ${b.logic}/${b.stopLossPct} → ${logic}/${wantSl}`,
      );
      await prisma.symbolBot.update({
        where: { id: b.id },
        data: {
          ...(needLogic ? { logic } : {}),
          ...(needSl ? { stopLossPct: wantSl, stopLossEnabled: true } : {}),
          ...(needTp ? { takeProfitPct: wantTp } : {}),
        },
      });
      fixed++;
    }
  }
  console.log(`preset bots checked=${bots.length} mismatch=${mismatch} fixed=${fixed}`);

  const accounts = await prisma.brokerAccount.findMany({
    where: {
      metaApiAccountId: { not: null },
      OR: [{ botEnabled: true }, { baskets: { some: { status: "open" } } }],
    },
    include: {
      user: { select: { email: true } },
      symbolBots: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });

  console.log(`\naccounts to check=${accounts.length}`);
  let overdue = 0;
  let okOpen = 0;

  for (const acc of accounts) {
    if (!acc.metaApiAccountId) continue;
    const live = await ensureCloudLive(acc.metaApiAccountId, 20_000);
    if (!live.ok) {
      console.log(`CLOUD FAIL ${acc.user.email} ${live.message}`);
      continue;
    }
    const snap = live.snap || (await fetchSnapshot(acc.metaApiAccountId));
    if (!snap.ok) {
      console.log(`SNAP FAIL ${acc.user.email}`);
      continue;
    }

    const groups = new Map<string, typeof snap.positions>();
    for (const p of snap.positions) {
      const dir = p.direction === "SELL" ? "SELL" : "BUY";
      const key = `${p.symbol}|${dir}`;
      const arr = groups.get(key) || [];
      arr.push(p);
      groups.set(key, arr);
    }

    if (!groups.size) {
      console.log(
        `OK idle ${acc.user.email} login=${acc.login} bot=${acc.botEnabled} eq=${snap.equity}`,
      );
      continue;
    }

    for (const [key, positions] of groups) {
      const [symbol, dir] = key.split("|") as [string, "BUY" | "SELL"];
      const bot = acc.symbolBots.find((x) => {
        const same =
          x.symbol.toUpperCase() === symbol.toUpperCase() ||
          (x.symbol.includes("XAU") &&
            (symbol.includes("XAU") || symbol.includes("GOLD")));
        if (!same) return false;
        if (x.dualDirection) return true;
        return (x.direction === "SELL" ? "SELL" : "BUY") === dir;
      });
      const logic = normalizeLogicId(bot?.logic || "dubai_bruno_313");
      const slPct = resolveLiveStopLossPct(logic, bot?.stopLossPct);
      const tpPct =
        logic === "dubai_bruno_313"
          ? bot && bot.takeProfitPct > 0
            ? bot.takeProfitPct
            : 20
          : resolveLiveTakeProfitPct(logic, bot?.takeProfitPct);

      const floating = positions.reduce((s, p) => s + p.profit, 0);
      const brokerMargin = positions.reduce(
        (s, p) => s + (typeof p.margin === "number" && p.margin > 0 ? p.margin : 0),
        0,
      );
      const lots = positions.reduce((s, p) => s + p.lots, 0);
      const avg =
        lots > 0 ? positions.reduce((s, p) => s + p.lots * p.price, 0) / lots : 0;
      const liveUsd = liveBasketTpSlUsd({
        symbol,
        lots,
        avgPrice: avg,
        takeProfitPct: tpPct,
        stopLossPct: slPct,
        brokerLeverage:
          snap.leverage > 0 ? snap.leverage : MT5_BROKER_LEVERAGE_DEFAULT,
        brokerMarginSum: brokerMargin > 0 ? brokerMargin : null,
      });
      const roi = mt5FloatingRoiPct(floating, liveUsd.marginUsd);
      const slHit = shouldTriggerStopLossUsd({
        pnl: floating,
        stopLossUsd: liveUsd.stopLossUsd,
        usedMargin: liveUsd.marginUsd,
        stopLossRoiPct: liveUsd.stopLossPct,
      });
      const tpHit = shouldTriggerTakeProfit({
        pnl: floating,
        takeProfitUsd: liveUsd.takeProfitUsd,
        usedMargin: liveUsd.marginUsd,
        tpRoiPct: liveUsd.takeProfitPct,
      });

      const row = {
        email: acc.user.email,
        login: acc.login,
        symbol,
        dir,
        logic,
        enabled: bot?.enabled ?? false,
        master: acc.botEnabled,
        floating: Math.round(floating * 100) / 100,
        margin: liveUsd.marginUsd,
        roi: Math.round(roi * 100) / 100,
        slLine: -liveUsd.stopLossUsd,
        slRoi: -slPct,
        shouldSl: slHit.hit,
        shouldTp: tpHit.hit,
        dbSl: bot?.stopLossPct,
        runtimeSl: slPct,
      };
      if (slHit.hit) {
        overdue++;
        console.log("OVERDUE_SL", JSON.stringify(row));
      } else {
        okOpen++;
        console.log("OPEN_OK", JSON.stringify(row));
      }
    }
  }

  console.log(`\nopen baskets ok=${okOpen} overdueSL=${overdue}`);
  if (overdue > 0) process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
