import { PrismaClient } from "@prisma/client";
import { resolveTpSlUsd } from "../src/lib/dca1000";

const p = new PrismaClient();

async function main() {
  const bots = await p.symbolBot.findMany();
  let n = 0;
  for (const b of bots) {
    const tpPct =
      b.takeProfitPct > 0 && b.takeProfitPct <= 5
        ? Math.round(b.takeProfitPct * 20 * 100) / 100
        : b.takeProfitPct > 0
          ? b.takeProfitPct
          : 20;
    const slPct =
      b.stopLossPct > 0 && b.stopLossPct < 10
        ? 225
        : b.stopLossPct > 0
          ? b.stopLossPct
          : 225;
    const usd = resolveTpSlUsd({
      symbol: b.symbol,
      startLots: b.startLots,
      takeProfitPct: tpPct,
      stopLossPct: slPct,
    });
    await p.symbolBot.update({
      where: { id: b.id },
      data: {
        takeProfitPct: tpPct,
        stopLossPct: slPct,
        takeProfitUsd: usd.takeProfitUsd,
        stopLossUsd: usd.stopLossUsd,
        stopLossEnabled: true,
      },
    });
    n += 1;
    console.log(b.symbol, {
      startLots: b.startLots,
      tpPct,
      slPct,
      ...usd,
    });
  }
  console.log("updated", n, "bots");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
