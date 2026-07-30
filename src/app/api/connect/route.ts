import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import {
  MAX_BROKER_ACCOUNTS_PER_USER,
  resolveActiveBrokerAccount,
  setActiveBrokerAccount,
} from "@/lib/account-selection";
import { hashPassword } from "@/lib/auth";
import { FIXED_MT5_SERVER } from "@/lib/dca";
import { ensureTradingSchema, prisma } from "@/lib/db";
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
  /** Re-submit credentials for an existing owned account (password fix). */
  reapply: z.boolean().optional(),
  /** Force create a new broker account row even if user already has others. */
  add: z.boolean().optional(),
  /** Target account id when reapply=true. */
  accountId: z.string().optional(),
  displayName: z.string().trim().max(40).optional().nullable(),
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
 *
 * Modes:
 * - add=true → always create a new account row (multi-account)
 * - reapply + accountId → update that owned account's credentials
 * - default → update matching login if owned, else create (or update only account if single)
 */
export async function POST(req: Request) {
  await ensureTradingSchema();
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
    const { login, password, reapply, add, accountId, displayName } = parsed.data;
    const server = FIXED_MT5_SERVER;
    const name = (displayName ?? "").trim() || null;

    const taken = await prisma.brokerAccount.findFirst({
      where: { login, NOT: { userId } },
    });
    if (taken) {
      return connectFail("이미 다른 회원에게 등록된 MT5 계좌입니다.", 409);
    }

    const ownedSameLogin = await prisma.brokerAccount.findFirst({
      where: { userId, login },
    });

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
      metaApiAccountId: null as string | null,
      ...(name ? { displayName: name } : {}),
    };

    // Explicit reapply for one account
    if (reapply && accountId) {
      const target = await prisma.brokerAccount.findFirst({
        where: { id: accountId, userId },
      });
      if (!target) return connectFail("계좌를 찾을 수 없습니다.", 404);
      if (target.botEnabled) {
        return connectFail("봇 실행 중에는 계좌 정보를 변경할 수 없습니다. 먼저 중지하세요.", 400);
      }
      const account = await prisma.brokerAccount.update({
        where: { id: target.id },
        data: pendingData,
      });
      await setActiveBrokerAccount(userId, account.id);
      return NextResponse.json({
        ok: true,
        pending: true,
        message: "재연동 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.",
        account: {
          id: account.id,
          login: account.login,
          server: account.server,
          status: account.status,
          displayName: account.displayName,
        },
      });
    }

    // Same login already owned → update that row (reconnect)
    if (ownedSameLogin) {
      if (ownedSameLogin.botEnabled) {
        return connectFail("봇 실행 중에는 계좌 정보를 변경할 수 없습니다. 먼저 중지하세요.", 400);
      }
      if (
        ownedSameLogin.metaApiAccountId &&
        ["connected", "undeployed"].includes(ownedSameLogin.status) &&
        !reapply &&
        !add
      ) {
        await setActiveBrokerAccount(userId, ownedSameLogin.id);
        return NextResponse.json({
          ok: true,
          alreadyLinked: true,
          message: "이미 연동된 계좌입니다. 계좌관리에서 선택하세요.",
          account: {
            id: ownedSameLogin.id,
            login: ownedSameLogin.login,
            server: ownedSameLogin.server,
            status: ownedSameLogin.status,
            displayName: ownedSameLogin.displayName,
          },
        });
      }
      const account = await prisma.brokerAccount.update({
        where: { id: ownedSameLogin.id },
        data: pendingData,
      });
      if (!(await prisma.strategyConfig.findUnique({ where: { accountId: account.id } }))) {
        await prisma.strategyConfig.create({ data: { accountId: account.id } });
      }
      await setActiveBrokerAccount(userId, account.id);
      return NextResponse.json({
        ok: true,
        pending: true,
        message: "연동 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.",
        account: {
          id: account.id,
          login: account.login,
          server: account.server,
          status: account.status,
          displayName: account.displayName,
        },
      });
    }

    // New login — create additional account (multi-account)
    const count = await prisma.brokerAccount.count({ where: { userId } });
    if (count >= MAX_BROKER_ACCOUNTS_PER_USER) {
      return connectFail(
        `계좌는 최대 ${MAX_BROKER_ACCOUNTS_PER_USER}개까지 등록할 수 있습니다.`,
        400,
      );
    }

    // Legacy single-account overwrite path: only when not adding and user has exactly one
    // and explicitly reapplying without accountId — still create new if add or count=0
    if (!add && count === 1 && reapply) {
      const only = await prisma.brokerAccount.findFirst({ where: { userId } });
      if (only && !only.botEnabled) {
        const account = await prisma.brokerAccount.update({
          where: { id: only.id },
          data: pendingData,
        });
        await setActiveBrokerAccount(userId, account.id);
        return NextResponse.json({
          ok: true,
          pending: true,
          message: "재연동 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.",
          account: {
            id: account.id,
            login: account.login,
            server: account.server,
            status: account.status,
            displayName: account.displayName,
          },
        });
      }
    }

    const account = await prisma.brokerAccount.create({
      data: {
        userId,
        ...pendingData,
        balance: 0,
        equity: 0,
        startingBalance: 0,
        config: { create: {} },
      },
    });
    await setActiveBrokerAccount(userId, account.id);

    return NextResponse.json({
      ok: true,
      pending: true,
      message: "연동 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.",
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        status: account.status,
        displayName: account.displayName,
      },
    });
  } catch (e) {
    console.error(e);
    return connectFail(e, 400);
  }
}

export async function GET() {
  await ensureTradingSchema();
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await resolveActiveBrokerAccount(gate.user.id);
  if (!account) return NextResponse.json({ account: null });
  const full = await prisma.brokerAccount.findUnique({
    where: { id: account.id },
    include: { config: true },
  });
  if (!full) return NextResponse.json({ account: null });
  const { passwordEnc: _, syncToken: __, ...safe } = full;
  return NextResponse.json({ account: safe });
}
