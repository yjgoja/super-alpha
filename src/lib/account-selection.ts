/**
 * Resolve the user's active broker account for app UI / control-plane APIs.
 * Engine ticks already enumerate all eligible accounts — this is for user-facing ops only.
 */
import { prisma } from "./db";

export const MAX_BROKER_ACCOUNTS_PER_USER = 10;

export type ActiveAccountSelect = {
  id: true;
  userId: true;
  displayName: true;
  login: true;
  server: true;
  status: true;
  statusMessage: true;
  metaApiAccountId: true;
  botEnabled: true;
  balance: true;
  equity: true;
  syncToken: true;
  mode: true;
  createdAt: true;
  updatedAt: true;
};

export const activeAccountSelect = {
  id: true,
  userId: true,
  displayName: true,
  login: true,
  server: true,
  status: true,
  statusMessage: true,
  metaApiAccountId: true,
  botEnabled: true,
  balance: true,
  equity: true,
  syncToken: true,
  mode: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function accountLabel(a: {
  displayName?: string | null;
  login: string;
}) {
  const name = (a.displayName || "").trim();
  return name || `MT5 ${a.login}`;
}

/** List all accounts for a user (no secrets). */
export async function listUserBrokerAccounts(userId: string) {
  return prisma.brokerAccount.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      displayName: true,
      login: true,
      server: true,
      status: true,
      statusMessage: true,
      metaApiAccountId: true,
      botEnabled: true,
      balance: true,
      equity: true,
      startingBalance: true,
      tpCount: true,
      slCount: true,
      cycleCount: true,
      lastSyncAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { baskets: { where: { status: "open" } } } },
    },
  });
}

/**
 * Prefer User.activeBrokerAccountId when still owned by user; else newest fallback.
 * Optionally persist the fallback so selection sticks.
 */
export async function resolveActiveBrokerAccount(
  userId: string,
  opts?: { persistFallback?: boolean },
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeBrokerAccountId: true },
  });

  if (user?.activeBrokerAccountId) {
    const active = await prisma.brokerAccount.findFirst({
      where: { id: user.activeBrokerAccountId, userId },
    });
    if (active) return active;
  }

  const fallback = await prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (fallback && opts?.persistFallback !== false) {
    await prisma.user
      .update({
        where: { id: userId },
        data: { activeBrokerAccountId: fallback.id },
      })
      .catch(() => null);
  }
  return fallback;
}

export async function setActiveBrokerAccount(userId: string, accountId: string) {
  const account = await prisma.brokerAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false as const, error: "계좌를 찾을 수 없습니다." };
  await prisma.user.update({
    where: { id: userId },
    data: { activeBrokerAccountId: account.id },
  });
  return { ok: true as const, accountId: account.id };
}

/**
 * Delete one broker account for the user.
 * Never force-closes live baskets — refuse if bot ON or open baskets exist.
 */
export async function deleteBrokerAccountForUser(userId: string, accountId: string) {
  const account = await prisma.brokerAccount.findFirst({
    where: { id: accountId, userId },
    include: {
      baskets: { where: { status: "open" }, select: { id: true } },
    },
  });
  if (!account) return { ok: false as const, error: "계좌를 찾을 수 없습니다." };
  if (account.botEnabled) {
    return {
      ok: false as const,
      error: "봇이 실행 중인 계좌는 삭제할 수 없습니다. 먼저 전체 중지를 하세요.",
    };
  }
  if (account.baskets.length > 0) {
    return {
      ok: false as const,
      error: "열린 바스켓이 있는 계좌는 삭제할 수 없습니다. 청산 후 다시 시도하세요.",
    };
  }

  // Soft float guard — likely live positions not yet reflected as open baskets
  if (
    account.balance > 0 &&
    account.equity > 0 &&
    Math.abs(account.balance - account.equity) > 1
  ) {
    return {
      ok: false as const,
      error: "미실현 손익이 있어 삭제를 보류했습니다. 포지션 확인 후 다시 시도하세요.",
    };
  }

  if (account.metaApiAccountId) {
    const { undeployAccount, removeMetaAccount } = await import("./metaapi");
    try {
      await undeployAccount(account.metaApiAccountId);
    } catch {
      /* continue */
    }
    await removeMetaAccount(account.metaApiAccountId);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeBrokerAccountId: true },
  });

  await prisma.brokerAccount.delete({ where: { id: account.id } });

  if (user?.activeBrokerAccountId === account.id) {
    const next = await prisma.brokerAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { activeBrokerAccountId: next?.id ?? null },
    });
  }

  return { ok: true as const };
}
