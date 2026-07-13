import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { encodeSecret, getSessionUserId } from "@/lib/auth";
import { FIXED_MT5_SERVER } from "@/lib/dca";
import { prisma } from "@/lib/db";

const schema = z.object({
  login: z.string().min(3),
  password: z.string().min(1),
  server: z.string().optional(),
});

function newSyncToken() {
  return randomBytes(24).toString("hex");
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());
    if (!/^\d+$/.test(body.login.trim())) {
      return NextResponse.json(
        { error: "계좌번호(MT5 Login)는 숫자여야 합니다." },
        { status: 400 },
      );
    }

    const server = FIXED_MT5_SERVER;
    const syncToken = newSyncToken();

    const existing = await prisma.brokerAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    let account;
    if (existing) {
      account = await prisma.brokerAccount.update({
        where: { id: existing.id },
        data: {
          login: body.login.trim(),
          passwordEnc: encodeSecret(body.password),
          server,
          status: "connected",
          syncToken,
          // keep live if already synced; otherwise wait for EA
          mode: existing.mode === "live" ? "live" : "demo",
        },
      });
      if (!(await prisma.strategyConfig.findUnique({ where: { accountId: account.id } }))) {
        await prisma.strategyConfig.create({ data: { accountId: account.id } });
      }
    } else {
      account = await prisma.brokerAccount.create({
        data: {
          userId,
          login: body.login.trim(),
          passwordEnc: encodeSecret(body.password),
          server,
          mode: "demo",
          status: "connected",
          syncToken,
          balance: 0,
          equity: 0,
          startingBalance: 0,
          config: { create: {} },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      instant: true,
      message: "계좌 연결 완료. EA에 Sync Token을 넣으면 MT5 실데이터가 표시됩니다.",
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        mode: account.mode,
        status: account.status,
        syncToken: account.syncToken,
      },
      eaHint: {
        url: "https://super-alpha-inky.vercel.app",
        endpoint: "/api/live/sync",
        login: account.login,
        token: account.syncToken,
      },
    });
  } catch (e) {
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
  return NextResponse.json({
    account: account
      ? {
          ...account,
          passwordEnc: undefined,
        }
      : null,
  });
}
