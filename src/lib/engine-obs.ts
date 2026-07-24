/**
 * Engine observability — naked positions, miss guards, cost signals.
 */
import { prisma } from "./db";
import { symbolsMatch } from "./metaapi";
import { peekMetaApiHttpWindow } from "./metaapi-metrics";

export async function countNakedBrokerPositions() {
  const open = await prisma.basket.findMany({
    where: { status: "open" },
    select: {
      id: true,
      symbol: true,
      direction: true,
      accountId: true,
      account: { select: { metaApiAccountId: true, login: true } },
    },
    take: 200,
  });
  return {
    openBaskets: open.length,
    sample: open.slice(0, 20).map((b) => ({
      login: b.account.login,
      symbol: b.symbol,
      direction: b.direction,
    })),
  };
}

export async function countRecentGuards(hours = 6) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const count = await prisma.fill.count({
    where: {
      createdAt: { gte: since },
      kind: "GUARD",
    },
  });
  return [{ kind: "GUARD", count }];
}

export function logEngineObservability(tag = "engine-obs") {
  const http = peekMetaApiHttpWindow();
  console.log(
    `[${tag}] httpPerMin=${http.perMinute.total} snap=${http.perMinute.snapshot} price=${http.perMinute.price} hist=${http.perMinute.history} trade=${http.perMinute.trade}`,
  );
  return http;
}

/** Positions missing broker TP while basket open — caller supplies live snap */
export function nakedLegsInSnap(opts: {
  positions: Array<{
    symbol: string;
    direction: string;
    takeProfit?: number;
    stopLoss?: number;
  }>;
  symbol: string;
  direction: "BUY" | "SELL";
}) {
  return opts.positions.filter(
    (p) =>
      symbolsMatch(p.symbol, opts.symbol) &&
      p.direction === opts.direction &&
      !(p.takeProfit != null && p.takeProfit > 0),
  ).length;
}
