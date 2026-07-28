/**
 * Sync martin_* SymbolBot.takeProfitPct to preset defense (10%).
 * Does not toggle bots or touch open-basket force-close.
 */
import { resolveTpSlUsd } from "../src/lib/dca1000";
import { prisma } from "../src/lib/db";
import { normalizeLogicId } from "../src/lib/strategies";
import {
  getMartin9Defense,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";

async function main() {
  const bots = await prisma.symbolBot.findMany();
  let fixed = 0;
  for (const b of bots) {
    const logic = normalizeLogicId(b.logic);
    const def = getMartin9Defense(logic);
    if (!def) continue;
    const wantTp = resolveLiveTakeProfitPct(logic, b.takeProfitPct);
    if (Math.abs(b.takeProfitPct - wantTp) < 0.01) continue;
    const usd = resolveTpSlUsd({
      symbol: b.symbol,
      startLots: b.startLots,
      takeProfitPct: wantTp,
      stopLossPct: b.stopLossPct,
    });
    await prisma.symbolBot.update({
      where: { id: b.id },
      data: { takeProfitPct: wantTp, takeProfitUsd: usd.takeProfitUsd },
    });
    fixed++;
    console.log(
      `${b.symbol} ${b.direction} ${logic}: TP ${b.takeProfitPct}% → ${wantTp}% ($${usd.takeProfitUsd})`,
    );
  }
  console.log("fixed", fixed, "of", bots.length);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
