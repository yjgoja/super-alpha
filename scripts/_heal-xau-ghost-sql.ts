import { PrismaClient } from "@prisma/client";
import { fetchSnapshot, symbolsMatch } from "../src/lib/metaapi";

const p = new PrismaClient();

async function main() {
  await p.$executeRawUnsafe(
    `ALTER TABLE "BrokerAccount" ADD COLUMN IF NOT EXISTS "h8SessionState" JSONB`,
  );
  console.log("h8SessionState column ok");

  const login = process.argv[2] || "135067048";
  const rows = await p.$queryRawUnsafe<
    Array<{ id: string; login: string; metaApiAccountId: string | null }>
  >(
    `SELECT id, login, "metaApiAccountId" FROM "BrokerAccount" WHERE login = $1 LIMIT 1`,
    login,
  );
  const a = rows[0];
  if (!a?.metaApiAccountId) throw new Error("account missing");

  const baskets = await p.$queryRawUnsafe<
    Array<{ id: string; symbol: string; direction: string; tradingPaused: boolean }>
  >(
    `SELECT id, symbol, direction, "tradingPaused" FROM "Basket"
     WHERE "accountId" = $1 AND status = 'open' AND (symbol ILIKE '%XAU%' OR symbol ILIKE '%GOLD%')`,
    a.id,
  );
  const snap = await fetchSnapshot(a.metaApiAccountId);
  if (!snap.ok) throw new Error(String((snap as { error?: string }).error || "snap"));

  for (const b of baskets) {
    const dir = b.direction === "SELL" ? "SELL" : "BUY";
    const live = snap.positions.filter(
      (x) => symbolsMatch(x.symbol, b.symbol) && x.direction === dir,
    );
    if (live.length > 0) {
      console.log("keep live", b.symbol, dir, live.length);
      continue;
    }
    await p.$executeRawUnsafe(
      `UPDATE "Basket" SET status='closed', "lastExitAt"=NOW(), "unrealizedPnl"=0, "tradingPaused"=false WHERE id=$1`,
      b.id,
    );
    await p.$executeRawUnsafe(
      `INSERT INTO "Fill" (id, "accountId", symbol, side, lots, price, kind, note, "createdAt")
       VALUES (cuid(), $1, $2, $3, 0, 0, 'GUARD', 'heal_ghost_paused_empty|sql', NOW())`,
      a.id,
      b.symbol,
      dir === "BUY" ? "SELL" : "BUY",
    ).catch(async () => {
      // cuid() may not exist — use gen_random_uuid style / prisma default
      await p.$executeRawUnsafe(
        `INSERT INTO "Fill" (id, "accountId", symbol, side, lots, price, kind, note, "createdAt")
         VALUES ($1, $2, $3, $4, 0, 0, 'GUARD', 'heal_ghost_paused_empty|sql', NOW())`,
        `heal_${Date.now()}`,
        a.id,
        b.symbol,
        dir === "BUY" ? "SELL" : "BUY",
      );
    });
    console.log("closed ghost", a.login, b.symbol, dir, "pausedWas", b.tradingPaused);
  }
}

main().finally(() => p.$disconnect());
