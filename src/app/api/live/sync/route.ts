import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth";
import { dayKeySeoul } from "@/lib/day-key";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

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
  password: z.string().min(1),
  /** EA AccountInfo().Login — must match login */
  accountLogin: z.string().optional(),
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
  return dayKeySeoul();
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const login = body.login.trim();
    const accountLogin = (body.accountLogin || login).trim();

    if (accountLogin !== login) {
      return NextResponse.json(
        { error: "accountLogin mismatch — EA must run on the registered MT5 account" },
        { status: 403 },
      );
    }

    const rl = rateLimit(`live-sync:${login}`, { limit: 60, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "요청이 너무 많습니다." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    const account = await prisma.brokerAccount.findFirst({
      where: { login },
      include: { user: { select: { approvalStatus: true, role: true } } },
    });
    if (!account) {
      return NextResponse.json(
        { error: "등록되지 않은 계좌입니다. 웹에서 먼저 계좌를 연결하세요." },
        { status: 404 },
      );
    }

    const ownerOk =
      account.user.role === "admin" || account.user.approvalStatus === "approved";
    if (!ownerOk) {
      return NextResponse.json(
        { error: "계정 승인 대기 중이거나 거절된 회원입니다." },
        { status: 403 },
      );
    }

    const ok = await verifyPassword(body.password, account.passwordEnc);
    if (!ok) {
      return NextResponse.json(
        { error: "MT5 비밀번호가 웹 등록 정보와 일치하지 않습니다." },
        { status: 401 },
      );
    }

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
        botEnabled: body.botEnabled ?? true,
        tpCount: body.tpCount ?? account.tpCount,
        slCount: body.slCount ?? account.slCount,
        cycleCount: body.cycleCount ?? account.cycleCount,
      },
    });

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
