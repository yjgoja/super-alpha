import { prisma } from "./db";
import { removeMetaAccount, undeployAccount } from "./metaapi";

export const IDLE_BOT_HOURS = 24;

/**
 * Undeploy MetaAPI cloud when trading bot has been OFF for >= 24 hours.
 * Signup-only / idle users stop burning MetaAPI hours.
 * Bot start will re-deploy via ensureCloudLive.
 */
export async function undeployIdleAccounts(idleHours = IDLE_BOT_HOURS) {
  const cutoff = new Date(Date.now() - idleHours * 60 * 60 * 1000);

  const idle = await prisma.brokerAccount.findMany({
    where: {
      metaApiAccountId: { not: null },
      botEnabled: false,
      status: { in: ["connected"] },
      // 열린 바스켓이 있으면 절대 undeploy 금지 (익절·손절 관리 중)
      baskets: { none: { status: "open" } },
      OR: [
        { botStoppedAt: { lte: cutoff } },
        // never started bot after link — use lastSyncAt / createdAt
        { botStoppedAt: null, lastSyncAt: { lte: cutoff } },
        { botStoppedAt: null, lastSyncAt: null, createdAt: { lte: cutoff } },
      ],
    },
  });

  const results: Array<{ id: string; login: string; ok: boolean; error?: string }> = [];

  for (const a of idle) {
    try {
      await undeployAccount(a.metaApiAccountId!);
      await prisma.brokerAccount.update({
        where: { id: a.id },
        data: {
          status: "undeployed",
          botEnabled: false,
          botStoppedAt: a.botStoppedAt ?? new Date(),
          statusMessage: `매매봇 ${idleHours}시간 미사용 · 클라우드 중지(비용 절감). 봇 시작 시 다시 활성화됩니다.`,
        },
      });
      results.push({ id: a.id, login: a.login, ok: true });
    } catch (e) {
      results.push({
        id: a.id,
        login: a.login,
        ok: false,
        error: e instanceof Error ? e.message : "undeploy failed",
      });
    }
  }

  return { count: idle.length, results, idleHours };
}

/** Fully remove MetaAPI cloud account + clear local link (stops almost all MetaAPI fees). */
export async function purgeMetaAccount(accountId: string) {
  const account = await prisma.brokerAccount.findUnique({ where: { id: accountId } });
  if (!account) return { ok: false as const, error: "계좌 없음" };

  if (account.metaApiAccountId) {
    try {
      await undeployAccount(account.metaApiAccountId);
    } catch {
      /* continue */
    }
    await removeMetaAccount(account.metaApiAccountId);
  }

  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      metaApiAccountId: null,
      botEnabled: false,
      botStoppedAt: new Date(),
      status: "failed",
      statusMessage: "클라우드 계좌 삭제됨(과금 중단)",
      syncToken: null,
    },
  });

  return { ok: true as const };
}

export async function deleteUserCompletely(userId: string, actorId: string) {
  if (userId === actorId) {
    return { ok: false as const, error: "본인 관리자 계정은 삭제할 수 없습니다." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { accounts: true },
  });
  if (!user) return { ok: false as const, error: "회원 없음" };
  if (user.role === "admin") {
    return { ok: false as const, error: "관리자 계정은 삭제할 수 없습니다." };
  }

  for (const a of user.accounts) {
    if (a.metaApiAccountId) {
      try {
        await undeployAccount(a.metaApiAccountId);
      } catch {
        /* continue */
      }
      await removeMetaAccount(a.metaApiAccountId);
    }
  }

  await prisma.user.delete({ where: { id: userId } });
  return { ok: true as const, email: user.email };
}
