import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId, hashPassword } from "@/lib/auth";
import { FIXED_MT5_SERVER } from "@/lib/dca";
import { prisma } from "@/lib/db";
import { verifyMt5Credentials } from "@/lib/metaapi";

export const maxDuration = 60;
export const runtime = "nodejs";

const schema = z.object({
  login: z
    .string()
    .trim()
    .regex(/^\d{5,15}$/, "MT5 계좌번호는 숫자 5~15자리여야 합니다."),
  password: z.string().min(4, "MT5 거래 비밀번호를 입력하세요.").max(64),
  server: z.string().optional(),
});

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "입력 오류" },
        { status: 400 },
      );
    }
    const { login, password } = parsed.data;
    const server = FIXED_MT5_SERVER;

    const taken = await prisma.brokerAccount.findFirst({
      where: { login, NOT: { userId } },
    });
    if (taken) {
      return NextResponse.json(
        { error: "이미 다른 회원에게 등록된 MT5 계좌입니다." },
        { status: 409 },
      );
    }

    const existing = await prisma.brokerAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    // Real broker validation via MetaAPI — rejects wrong login/password
    const verified = await verifyMt5Credentials({
      login,
      password,
      server,
      reuseAccountId: existing?.metaApiAccountId,
    });

    if (!verified.ok) {
      return NextResponse.json(
        {
          error: verified.message,
          code: verified.code,
        },
        { status: verified.code === "NO_TOKEN" ? 503 : 401 },
      );
    }

    const passwordHash = await hashPassword(password);

    let account;
    if (existing) {
      account = await prisma.brokerAccount.update({
        where: { id: existing.id },
        data: {
          login,
          passwordEnc: passwordHash,
          server,
          status: "connected",
          mode: "live",
          metaApiAccountId: verified.metaApiAccountId,
          lastSyncAt: new Date(),
          balance: verified.balance,
          equity: verified.equity,
          startingBalance:
            existing.startingBalance > 0 ? existing.startingBalance : verified.balance,
          botEnabled: true,
        },
      });
      if (!(await prisma.strategyConfig.findUnique({ where: { accountId: account.id } }))) {
        await prisma.strategyConfig.create({ data: { accountId: account.id } });
      }
    } else {
      account = await prisma.brokerAccount.create({
        data: {
          userId,
          login,
          passwordEnc: passwordHash,
          server,
          mode: "live",
          status: "connected",
          metaApiAccountId: verified.metaApiAccountId,
          lastSyncAt: new Date(),
          balance: verified.balance,
          equity: verified.equity,
          startingBalance: verified.balance,
          botEnabled: true,
          config: { create: {} },
        },
      });
    }

    // Refresh open baskets from MetaAPI positions
    await prisma.basketLeg.deleteMany({
      where: { basket: { accountId: account.id, status: "open" } },
    });
    await prisma.basket.deleteMany({
      where: { accountId: account.id, status: "open" },
    });

    const bySymbol = new Map<string, typeof verified.positions>();
    for (const p of verified.positions) {
      const list = bySymbol.get(p.symbol) ?? [];
      list.push(p);
      bySymbol.set(p.symbol, list);
    }
    for (const [symbol, legs] of bySymbol) {
      const first = legs[0];
      const unrealized = legs.reduce((s, l) => s + l.profit, 0);
      await prisma.basket.create({
        data: {
          accountId: account.id,
          symbol,
          direction: first.direction,
          filledLevel: Math.max(0, legs.length - 1),
          firstEntryPrice: first.price,
          status: "open",
          unrealizedPnl: unrealized,
          legs: {
            create: legs.map((l, idx) => ({
              level: idx,
              lots: l.lots,
              price: l.price,
            })),
          },
        },
      });
    }

    await prisma.equitySnapshot.create({
      data: {
        accountId: account.id,
        equity: verified.equity,
        balance: verified.balance,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "MetaAPI 실계좌 검증 완료 — 연결되었습니다.",
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        mode: account.mode,
        status: account.status,
        balance: account.balance,
        equity: account.equity,
        currency: verified.currency,
        leverage: verified.leverage,
      },
    });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "연결 실패";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    include: { config: true },
    orderBy: { createdAt: "desc" },
  });
  if (!account) return NextResponse.json({ account: null });
  const { passwordEnc: _, ...safe } = account;
  return NextResponse.json({ account: safe });
}
