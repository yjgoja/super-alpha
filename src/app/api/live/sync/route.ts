import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

const positionSchema = z.object({
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  lots: z.number(),
  price: z.number(),
  profit: z.number().default(0),
  level: z.number().int().default(0),
  magic: z.number().optional(),
});

const schema = z.object({
  login: z.string().min(3),
  token: z.string().min(8),
  balance: z.number(),
  equity: z.number(),
  tpCount: z.number().int().optional(),
  slCount: z.number().int().optional(),
  cycleCount: z.number().int().optional(),
  botEnabled: z.boolean().optional(),
  positions: z.array(positionSchema).default([]),
  event: z
    .object({
      kind: z.enum(["TP", "SL", "ENTRY", "DCA"]),
      symbol: z.string(),
      side: z.string().optional(),
      lots: z.number().optional(),
      price: z.number().optional(),
      pnl: z.number().optional(),
      level: z.number().optional(),
      note: z.string().optional(),
    })
    .nullable()
    .optional(),
});

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const account = await prisma.brokerAccount.findFirst({
      where: { login: body.login.trim(), syncToken: body.token },
    });
    if (!account) {
      return NextResponse.json({ error: "invalid login/token" }, { status: 401 });
    }

    // First live sync: lock starting balance to real balance once
    const startingBalance =
      account.mode === "live" || account.lastSyncAt
        ? account.startingBalance
        : body.balance;

    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        mode: "live",
        status: "connected",
        lastSyncAt: new Date(),
        balance: body.balance,
        equity: body.equity,
        startingBalance,
        botEnabled: body.botEnabled ?? account.botEnabled,
        tpCount: body.tpCount ?? account.tpCount,
        slCount: body.slCount ?? account.slCount,
        cycleCount: body.cycleCount ?? account.cycleCount,
      },
    });

    // Rebuild open baskets from live positions (group by symbol)
    await prisma.basketLeg.deleteMany({
      where: { basket: { accountId: account.id, status: "open" } },
    });
    await prisma.basket.deleteMany({
      where: { accountId: account.id, status: "open" },
    });

    const bySymbol = new Map<string, z.infer<typeof positionSchema>[]>();
    for (const p of body.positions) {
      const list = bySymbol.get(p.symbol) ?? [];
      list.push(p);
      bySymbol.set(p.symbol, list);
    }

    for (const [symbol, legs] of bySymbol) {
      legs.sort((a, b) => a.level - b.level);
      const first = legs[0];
      const unrealized = legs.reduce((s, l) => s + l.profit, 0);
      const maxLevel = Math.max(...legs.map((l) => l.level));
      await prisma.basket.create({
        data: {
          accountId: account.id,
          symbol,
          direction: first.direction,
          filledLevel: maxLevel,
          firstEntryPrice: first.price,
          status: "open",
          unrealizedPnl: unrealized,
          legs: {
            create: legs.map((l) => ({
              level: l.level,
              lots: l.lots,
              price: l.price,
            })),
          },
        },
      });
    }

    if (body.event) {
      await prisma.fill.create({
        data: {
          accountId: account.id,
          symbol: body.event.symbol,
          side: body.event.side ?? body.event.kind,
          lots: body.event.lots ?? 0,
          price: body.event.price ?? 0,
          pnl: body.event.pnl ?? 0,
          kind: body.event.kind,
          level: body.event.level,
          note: body.event.note,
        },
      });
    }

    // Daily + snapshot
    const date = todayKey();
    const existing = await prisma.dailyStat.findUnique({
      where: { accountId_date: { accountId: account.id, date } },
    });
    if (!existing) {
      await prisma.dailyStat.create({
        data: {
          accountId: account.id,
          date,
          startEquity: body.equity,
          endEquity: body.equity,
        },
      });
    } else {
      const pnl = body.equity - existing.startEquity;
      await prisma.dailyStat.update({
        where: { id: existing.id },
        data: {
          endEquity: body.equity,
          pnl,
          returnPct: existing.startEquity
            ? (pnl / existing.startEquity) * 100
            : 0,
        },
      });
    }

    await prisma.equitySnapshot.create({
      data: {
        accountId: account.id,
        equity: body.equity,
        balance: body.balance,
      },
    });

    return NextResponse.json({ ok: true, mode: "live", at: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
