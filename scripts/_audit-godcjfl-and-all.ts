import { PrismaClient } from "@prisma/client";
import { h8SessionKey, canH8Enter, minutesSinceH8Open } from "../src/lib/session-h8";

const p = new PrismaClient();

async function main() {
  const now = new Date();
  console.log({
    utc: now.toISOString(),
    session: h8SessionKey(now),
    canEnter: canH8Enter(now),
    mins: minutesSinceH8Open(now),
  });

  const rows = await p.$queryRawUnsafe<
    Array<{
      id: string;
      login: string;
      status: string;
      botEnabled: boolean;
      equity: number;
      h8SessionState: unknown;
    }>
  >(
    `SELECT id, login, status, "botEnabled", equity, "h8SessionState"
     FROM "BrokerAccount" WHERE login='130064045' LIMIT 1`,
  );
  const a = rows[0]!;
  console.log("account", {
    login: a.login,
    status: a.status,
    botEnabled: a.botEnabled,
    equity: a.equity,
    h8: a.h8SessionState,
  });

  const bots = await p.$queryRawUnsafe<
    Array<{ symbol: string; direction: string; enabled: boolean; logic: string; startLots: number }>
  >(
    `SELECT symbol, direction, enabled, logic, "startLots" FROM "SymbolBot" WHERE "accountId"=$1`,
    a.id,
  );
  console.log("bots", bots);

  const baskets = await p.$queryRawUnsafe<
    Array<{ id: string; symbol: string; direction: string; status: string; legs: number; updatedAt: Date }>
  >(
    `SELECT b.id, b.symbol, b.direction, b.status,
            (SELECT count(*)::int FROM "BasketLeg" l WHERE l."basketId"=b.id) AS legs,
            b."updatedAt"
     FROM "Basket" b WHERE b."accountId"=$1 AND b.status='open'`,
    a.id,
  );
  console.log("open baskets", baskets);

  const fills = await p.$queryRawUnsafe<
    Array<{
      kind: string;
      side: string;
      symbol: string;
      lots: number;
      note: string;
      createdAt: Date;
    }>
  >(
    `SELECT kind, side, symbol, lots, coalesce(note,'') as note, "createdAt"
     FROM "Fill" WHERE "accountId"=$1 AND "createdAt" >= now() - interval '48 hours'
     ORDER BY "createdAt" DESC LIMIT 50`,
    a.id,
  );
  console.log("\nfills 48h:");
  for (const f of fills) {
    console.log(
      f.createdAt.toISOString(),
      f.kind,
      f.side,
      f.symbol,
      f.lots,
      f.note.slice(0, 100),
    );
  }

  const today = await p.$queryRawUnsafe<
    Array<{ kind: string; n: number }>
  >(
    `SELECT kind, count(*)::int AS n FROM "Fill"
     WHERE "accountId"=$1 AND "createdAt" >= '2026-08-05T15:00:00Z'
     GROUP BY kind ORDER BY n DESC`,
    a.id,
  );
  console.log("\ntoday KST fill counts:", today);

  // All accounts issue scan
  console.log("\n=== ALL H8 time bots ===");
  const h8bots = await p.$queryRawUnsafe<
    Array<{
      login: string;
      email: string;
      equity: number;
      status: string;
      botEnabled: boolean;
      symbol: string;
      direction: string;
      logic: string;
      h8SessionState: unknown;
      openLegs: number;
    }>
  >(
    `SELECT ba.login, u.email, ba.equity, ba.status, ba."botEnabled",
            sb.symbol, sb.direction, sb.logic, ba."h8SessionState",
            (
              SELECT coalesce(sum((SELECT count(*) FROM "BasketLeg" l WHERE l."basketId"=b.id)),0)::int
              FROM "Basket" b
              WHERE b."accountId"=ba.id AND b.status='open'
                AND (b.symbol ILIKE '%XAU%' OR b.symbol ILIKE '%GOLD%')
            ) AS "openLegs"
     FROM "SymbolBot" sb
     JOIN "BrokerAccount" ba ON ba.id=sb."accountId"
     JOIN "User" u ON u.id=ba."userId"
     WHERE sb.enabled=true AND ba."botEnabled"=true
       AND (sb.logic ILIKE '%time%' OR sb.logic ILIKE '%h8%')`,
  );
  for (const r of h8bots) {
    console.log(
      r.login,
      r.email.split("@")[0],
      `eq=${r.equity}`,
      `${r.symbol} cfgDir=${r.direction} ${r.logic}`,
      `openLegs=${r.openLegs}`,
      "h8=",
      JSON.stringify(r.h8SessionState),
    );
  }

  console.log("\n=== enabled bots without open XAU/EUR/GBP basket + recent activity ===");
  const all = await p.$queryRawUnsafe<
    Array<{
      login: string;
      email: string;
      equity: number;
      status: string;
      symbol: string;
      direction: string;
      logic: string;
      openCount: number;
      lastKind: string | null;
      lastAt: Date | null;
      lastNote: string | null;
    }>
  >(
    `SELECT ba.login, u.email, ba.equity, ba.status,
            sb.symbol, sb.direction, sb.logic,
            (
              SELECT count(*)::int FROM "Basket" b
              WHERE b."accountId"=ba.id AND b.status='open'
                AND (
                  left(upper(regexp_replace(b.symbol,'[^A-Za-z]','','g')),6)
                  = left(upper(regexp_replace(sb.symbol,'[^A-Za-z]','','g')),6)
                )
                AND b.direction = CASE WHEN sb.direction='SELL' THEN 'SELL' ELSE 'BUY' END
            ) AS "openCount",
            lf.kind AS "lastKind",
            lf."createdAt" AS "lastAt",
            left(coalesce(lf.note,''),80) AS "lastNote"
     FROM "SymbolBot" sb
     JOIN "BrokerAccount" ba ON ba.id=sb."accountId"
     JOIN "User" u ON u.id=ba."userId"
     LEFT JOIN LATERAL (
       SELECT f.kind, f."createdAt", f.note
       FROM "Fill" f
       WHERE f."accountId"=ba.id
         AND f."createdAt" >= now() - interval '48 hours'
         AND (
           f.symbol ILIKE '%' || left(regexp_replace(sb.symbol,'[^A-Za-z]','','g'),3) || '%'
         )
         AND f.kind IN ('ENTRY','DCA','TP','SL','GUARD','SESSION')
       ORDER BY f."createdAt" DESC
       LIMIT 1
     ) lf ON true
     WHERE sb.enabled=true AND ba."botEnabled"=true
     ORDER BY ba.login, sb.symbol, sb.direction`,
  );

  let issues = 0;
  for (const r of all) {
    const flags: string[] = [];
    if (r.status !== "connected") flags.push(`status=${r.status}`);
    if (r.openCount === 0) {
      if (/time/i.test(r.logic)) flags.push("H8_FLAT");
      if ((r.equity ?? 0) < 20 && /XAU|GOLD/i.test(r.symbol)) flags.push(`low_eq=${r.equity}`);
      if (r.lastKind === "GUARD" && /soft_close|margin|volume|not_on_book/i.test(r.lastNote || "")) {
        flags.push(`guard=${(r.lastNote || "").slice(0, 50)}`);
      }
      if (!r.lastAt || Date.now() - r.lastAt.getTime() > 6 * 3600e3) {
        flags.push("stale_or_no_fill_6h");
      }
    }
    const mark = flags.length ? "⚠" : r.openCount > 0 ? "●" : "○";
    if (flags.length) issues += 1;
    console.log(
      mark,
      r.login,
      r.email.split("@")[0],
      `eq=${r.equity}`,
      `${r.symbol} ${r.direction} ${r.logic}`,
      r.openCount > 0 ? `OPEN=${r.openCount}` : "FLAT",
      r.lastAt
        ? `last=${r.lastAt.toISOString()} ${r.lastKind}`
        : "last=none",
      flags.length ? `| ${flags.join("; ")}` : "",
    );
  }
  console.log("issue rows:", issues, "/", all.length);

  console.log("\n=== system fills 3h by login/kind ===");
  const sys = await p.$queryRawUnsafe<
    Array<{ login: string; kind: string; n: number }>
  >(
    `SELECT ba.login, f.kind, count(*)::int AS n
     FROM "Fill" f JOIN "BrokerAccount" ba ON ba.id=f."accountId"
     WHERE f."createdAt" >= now() - interval '3 hours'
       AND f.kind IN ('ENTRY','DCA','TP','SL')
     GROUP BY ba.login, f.kind
     ORDER BY ba.login, f.kind`,
  );
  console.log(sys);
  if (!sys.some((x) => x.login === "130064045")) {
    console.log("!!! godcjfl ZERO ENTRY/DCA/TP/SL in 3h");
  }
}

main().finally(() => p.$disconnect());
