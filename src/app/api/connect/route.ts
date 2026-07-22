import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { hashPassword } from "@/lib/auth";
import { FIXED_MT5_SERVER } from "@/lib/dca";
import { prisma } from "@/lib/db";
import { gateErrorKo, toKoreanError } from "@/lib/ko-errors";

export const maxDuration = 30;
export const runtime = "nodejs";

const schema = z.object({
  login: z
    .string()
    .trim()
    .regex(/^\d{5,15}$/, "MT5 계좌번호는 숫자 5~15자리여야 합니다."),
  password: z.string().min(4, "MT5 거래 비밀번호를 입력하세요.").max(64),
  server: z.string().optional(),
  reapply: z.boolean().optional(),
});

function connectFail(message: unknown, status = 400, code?: string) {
  return NextResponse.json(
    {
      error: toKoreanError(message, "계좌 연결 신청에 실패했습니다. 잠시 후 다시 시도하세요."),
      code: code || undefined,
    },
    { status },
  );
}

/**
 * User submits MT5 credentials → pending_registration for admin 연동 승인.
 * MetaAPI verification happens only when admin clicks 승인.
 */
export async function POST(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const userId = gate.user.id;

  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return connectFail(parsed.error.issues[0]?.message || "입력 오류", 400);
    }
    const { login, password, reapply } = parsed.data;
    const server = FIXED_MT5_SERVER;

    const taken = await prisma.brokerAccount.findFirst({
      where: { login, NOT: { userId } },
    });
    if (taken) {
      return connectFail("이미 다른 회원에게 등록된 MT5 계좌입니다.", 409);
    }

    const existing = await prisma.brokerAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    // Already fully linked — require explicit reapply to change password
    if (
      existing?.metaApiAccountId &&
      ["connected", "undeployed"].includes(existing.status) &&
      !reapply
    ) {
      return NextResponse.json({
        ok: true,
        alreadyLinked: true,
        message: "이미 실계좌가 연동되어 있습니다.",
        account: {
          id: existing.id,
          login: existing.login,
          server: existing.server,
          status: existing.status,
        },
      });
    }

    const passwordHash = await hashPassword(password);
    const pendingData = {
      login,
      passwordEnc: passwordHash,
      syncToken: password,
      server,
      mode: "live" as const,
      status: "pending_registration" as const,
      statusMessage: "관리자 연동 승인 대기 중",
      botEnabled: false,
      botStoppedAt: new Date(),
      // Clear previous Meta link until admin re-approves (forces fresh password check)
      metaApiAccountId: null as string | null,
    };

    let account;
    if (existing) {
      account = await prisma.brokerAccount.update({
        where: { id: existing.id },
        data: pendingData,
      });
      if (!(await prisma.strategyConfig.findUnique({ where: { accountId: account.id } }))) {
        await prisma.strategyConfig.create({ data: { accountId: account.id } });
      }
    } else {
      account = await prisma.brokerAccount.create({
        data: {
          userId,
          ...pendingData,
          balance: 0,
          equity: 0,
          startingBalance: 0,
          config: { create: {} },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      pending: true,
      message: "연동 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.",
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        status: account.status,
      },
    });
  } catch (e) {
    console.error(e);
    return connectFail(e, 400);
  }
}

export async function GET() {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    include: { config: true },
    orderBy: { createdAt: "desc" },
  });
  if (!account) return NextResponse.json({ account: null });
  const { passwordEnc: _, syncToken: __, ...safe } = account;
  return NextResponse.json({ account: safe });
}
