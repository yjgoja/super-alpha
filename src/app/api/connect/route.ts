import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId, hashPassword, verifyPassword } from "@/lib/auth";
import { FIXED_MT5_SERVER } from "@/lib/dca";
import { prisma } from "@/lib/db";

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
    const passwordHash = await hashPassword(password);

    // 다른 유저가 이미 등록한 계좌면 거부
    const taken = await prisma.brokerAccount.findFirst({
      where: { login, NOT: { userId } },
    });
    if (taken) {
      return NextResponse.json(
        { error: "이미 다른 계정에 등록된 MT5 계좌번호입니다." },
        { status: 409 },
      );
    }

    const existing = await prisma.brokerAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    let account;
    if (existing) {
      // 같은 계좌 재연결: 비번 갱신 / 다른 계좌로 변경 허용
      account = await prisma.brokerAccount.update({
        where: { id: existing.id },
        data: {
          login,
          passwordEnc: passwordHash,
          server,
          status: "pending", // EA 실동기화 전까지 대기
          mode: "demo",
          lastSyncAt: null,
          syncToken: null,
          balance: 0,
          equity: 0,
          // startingBalance는 첫 live sync에서 설정
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
          mode: "demo",
          status: "pending",
          balance: 0,
          equity: 0,
          startingBalance: 0,
          config: { create: {} },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      message:
        "계좌가 등록되었습니다. MT5 EA에 같은 계좌 비밀번호를 넣으면 실데이터로 연결됩니다. (별도 토큰 불필요)",
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        mode: account.mode,
        status: account.status,
      },
      eaHint: {
        url: "https://super-alpha-inky.vercel.app",
        loginFromAccount: true,
        password: "웹에 입력한 MT5 거래 비밀번호와 동일",
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
  if (!account) return NextResponse.json({ account: null });
  const { passwordEnc: _, ...safe } = account;
  return NextResponse.json({ account: safe });
}
