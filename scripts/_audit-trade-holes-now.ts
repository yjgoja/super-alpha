/**
 * Hard live hole-scan: naked, H8 stuck, margin spam, open without protect notes.
 * Run: npx tsx --env-file=.env scripts/_audit-trade-holes-now.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  canH8Enter,
  h8SessionKey,
  isInH8EntryQuiet,
  minutesSinceH8Open,
} from "../src/lib/session-h8";
import { isMartin9TimeLogic } from "../src/lib/table-logics";
import { fetchSnapshot, symbolsMatch } from "../src/lib/metaapi";
import { mt5UsedMargin, MT5_BROKER_LEVERAGE_DEFAULT } from "../src/lib/dca1000";

const p = new PrismaClient();

type Hole = { sev: "critical" | "high" | "medium"; login: string; msg: string };

async function main() {
  const now = new Date();
  const holes: Hole[] = [];
  console.log(
    JSON.stringify(
      {
        utc: now.toISOString(),
        h8: {
          session: h8SessionKey(now),
          quiet: isInH8EntryQuiet(now),
          canEnter: canH8Enter(now),
          mins: minutesSinceH8Open(now),
        },
      },
      null,
      2,
    ),
  );

  const accounts = await p.brokerAccount.findMany({
    where: { botEnabled: true },
    include: {
      user: { select: { email: true } },
      symbolBots: { where: { enabled: true } },
      baskets: { where: { status: "open" }, include: { legs: true } },
    },
  });

  const since1h = new Date(Date.now() - 3600e3);
  const since15m = new Date(Date.now() - 15 * 60e3);

  for (const a of accounts) {
    const email = (a.user?.email || "").split("@")[0] || "";
    const h8 = (a as { h8SessionState?: Record<string, { entered?: boolean; direction?: string; sessionKey?: string; barOpen?: number | null }> }).h8SessionState || {};

    for (const b of a.symbolBots) {
      const open = a.baskets.filter((x) => {
        const symOk =
          symbolsMatch(x.symbol, b.symbol) ||
          x.symbol.toUpperCase().includes(b.symbol.slice(0, 3).toUpperCase());
        // H8 ignores DB direction — any open on symbol counts
        if (isMartin9TimeLogic(b.logic)) return symOk;
        const dir = b.direction === "SELL" ? "SELL" : "BUY";
        return symOk && x.direction === dir;
      });

      if (isMartin9TimeLogic(b.logic)) {
        const key = Object.keys(h8).find((k) =>
          k.toUpperCase().includes(b.symbol.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase()),
        );
        const st = key ? h8[key] : undefined;
        if (
          canH8Enter(now) &&
          !isInH8EntryQuiet(now) &&
          open.length === 0 &&
          a.status === "connected" &&
          st?.sessionKey === h8SessionKey(now) &&
          st.barOpen != null &&
          (st.direction === "BUY" || st.direction === "SELL")
        ) {
          // flat with locked dir during tradeable window — allow ~3m after last TP
          const last = await p.$queryRawUnsafe<Array<{ kind: string; createdAt: Date; note: string }>>(
            `SELECT kind, "createdAt", coalesce(note,'') as note FROM "Fill"
             WHERE "accountId"=$1 AND (symbol ILIKE '%XAU%' OR symbol ILIKE '%GOLD%')
               AND kind IN ('ENTRY','TP','SL','GUARD')
             ORDER BY "createdAt" DESC LIMIT 1`,
            a.id,
          );
          const lastF = last[0];
          const ageMs = lastF ? Date.now() - lastF.createdAt.getTime() : 9e15;
          if (!lastF || (lastF.kind === "TP" && ageMs > 3 * 60_000) || (lastF.kind === "GUARD" && ageMs > 5 * 60_000)) {
            holes.push({
              sev: "high",
              login: a.login,
              msg: `H8_FLAT_STUCK ${email} dir=${st.direction} last=${lastF ? `${lastF.createdAt.toISOString()} ${lastF.kind}` : "none"} ageMin=${(ageMs / 60000).toFixed(1)}`,
            });
          }
        }
        if (st?.sessionKey && st.sessionKey !== h8SessionKey(now) && open.length > 0) {
          holes.push({
            sev: "critical",
            login: a.login,
            msg: `H8_OPEN_ON_STALE_SESSION open=${open.length} st=${st.sessionKey} now=${h8SessionKey(now)}`,
          });
        }
      }

      // tiny equity XAU still attempting entries
      if (/XAU|GOLD/i.test(b.symbol) && (a.equity ?? 0) > 0 && (a.equity ?? 0) < 20) {
        const need = mt5UsedMargin({
          symbol: b.symbol,
          lots: Math.max(0.01, Number(b.startLots || 0.01)),
          avgPrice: 4200,
          brokerLeverage: MT5_BROKER_LEVERAGE_DEFAULT,
        });
        const guards = await p.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "Fill"
           WHERE "accountId"=$1 AND kind='GUARD' AND "createdAt" >= $2
             AND note ILIKE '%entry_ok_but_not_on_book%'`,
          a.id,
          since15m,
        );
        if ((guards[0]?.n || 0) >= 2) {
          holes.push({
            sev: "high",
            login: a.login,
            msg: `MARGIN_SPAM eq=${a.equity} need~${need.toFixed(2)} guards15m=${guards[0]?.n}`,
          });
        }
      }
    }

    // open basket without recent protect activity is OK if positions have TP;
    // double-check via MetaAPI for connected accounts with open baskets
  }

  // MetaAPI naked scan (connected + open baskets only)
  const metaSeen = new Set<string>();
  for (const a of accounts) {
    if (a.status !== "connected" || !a.metaApiAccountId) continue;
    if (!a.baskets.length) continue;
    if (metaSeen.has(a.metaApiAccountId)) continue;
    metaSeen.add(a.metaApiAccountId);
    const snap = await fetchSnapshot(a.metaApiAccountId);
    if (!snap.ok) {
      holes.push({ sev: "medium", login: a.login, msg: `SNAP_FAIL ${snap.message}` });
      continue;
    }
    const naked = snap.positions.filter(
      (pos) => !(typeof pos.takeProfit === "number" && pos.takeProfit > 0),
    );
    if (naked.length) {
      holes.push({
        sev: "critical",
        login: a.login,
        msg: `NAKED_NO_TP count=${naked.length} ${naked.map((x) => `${x.symbol}:${x.direction}:${x.lots}`).join(",")}`,
      });
    }
    const noSl = snap.positions.filter(
      (pos) => !(typeof pos.stopLoss === "number" && pos.stopLoss > 0),
    );
    // SL may be disabled by bot setting — only flag if any open basket exists and ALL have no SL? skip soft
    if (noSl.length && naked.length === 0) {
      // informational — many bots have stopLossEnabled; check bots
    }
  }

  // Recent system errors
  const badGuards = await p.$queryRawUnsafe<
    Array<{ login: string; n: number; sample: string }>
  >(
    `SELECT ba.login, count(*)::int AS n, left(max(f.note),80) AS sample
     FROM "Fill" f JOIN "BrokerAccount" ba ON ba.id=f."accountId"
     WHERE f.kind='GUARD' AND f."createdAt" >= $1
       AND (
         f.note ILIKE '%entry_unprotected%'
         OR f.note ILIKE '%naked%'
         OR f.note ILIKE '%entry_ok_but_not_on_book%'
         OR f.note ILIKE '%soft_close_failed%'
         OR f.note ILIKE '%h8_already%'
       )
     GROUP BY ba.login
     ORDER BY n DESC
     LIMIT 20`,
    since1h,
  );
  console.log("\n=== GUARD anomalies 1h ===");
  for (const g of badGuards) {
    console.log(g.login, g.n, g.sample);
    if (g.n >= 5 && /entry_ok_but_not_on_book|entry_unprotected|naked/i.test(g.sample)) {
      holes.push({
        sev: "high",
        login: g.login,
        msg: `GUARD_FLOOD n=${g.n} sample=${g.sample}`,
      });
    }
  }

  // godcjfl pulse
  const god = accounts.find((x) => x.login === "130064045");
  if (god) {
    const recent = await p.$queryRawUnsafe<
      Array<{ kind: string; side: string; lots: number; note: string; createdAt: Date }>
    >(
      `SELECT kind, side, lots, coalesce(note,'') as note, "createdAt"
       FROM "Fill" WHERE "accountId"=$1 AND "createdAt" >= $2
         AND kind IN ('ENTRY','DCA','TP','SL','SESSION')
       ORDER BY "createdAt" DESC LIMIT 15`,
      god.id,
      since1h,
    );
    console.log("\n=== godcjfl last 1h ===");
    for (const f of recent) {
      console.log(f.createdAt.toISOString(), f.kind, f.side, f.lots, f.note.slice(0, 70));
    }
    console.log(
      "open",
      god.baskets.map((b) => `${b.symbol} ${b.direction} legs=${b.legs.length}`),
    );
  }

  console.log("\n=== HOLES ===");
  if (!holes.length) console.log("NONE");
  for (const h of holes.sort((a, b) => a.sev.localeCompare(b.sev))) {
    console.log(`[${h.sev}] ${h.login} ${h.msg}`);
  }
  console.log(`\nhole_count=${holes.length}`);
}

main().finally(() => p.$disconnect());
