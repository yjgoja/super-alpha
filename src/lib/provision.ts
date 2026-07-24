import { prisma } from "./db";
import { toKoreanError } from "./ko-errors";
import {
  fetchSnapshot,
  findMetaAccountByLogin,
  getMetaAccountStatus,
} from "./metaapi";

function looksLikeUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
}

async function markLinked(
  accountId: string,
  snap: { metaApiAccountId: string; balance: number; equity: number },
) {
  const metaId = String(snap.metaApiAccountId);
  // Keep DEPLOYED after approval — 500-user scale needs instant start-all,
  // MetaAPI must show Connected (idle undeploy only after bot OFF 24h).
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      metaApiAccountId: metaId,
      status: "connected",
      statusMessage:
        "연동 완료 · 클라우드 연결됨. 앱에서 전체 시작을 누르면 봇이 실행됩니다.",
      mode: "live",
      balance: snap.balance,
      equity: snap.equity,
      startingBalance: snap.balance,
      lastSyncAt: new Date(),
      botEnabled: false,
      botStoppedAt: new Date(),
    },
  });
}

/** Resolve wrong numeric MetaAPI ids by looking up login in MetaAPI. */
async function ensureCorrectMetaId(account: {
  id: string;
  login: string;
  metaApiAccountId: string | null;
}) {
  let metaId = account.metaApiAccountId ? String(account.metaApiAccountId) : "";
  if (metaId && looksLikeUuid(metaId)) return metaId;

  const found = await findMetaAccountByLogin(account.login);
  if (found?.id) {
    metaId = found.id;
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { metaApiAccountId: metaId },
    });
    return metaId;
  }
  return metaId || null;
}

/** Poll MetaAPI and finalize DB when broker is connected. */
export async function finalizeProvisionIfReady(accountId: string) {
  const account = await prisma.brokerAccount.findUnique({ where: { id: accountId } });
  if (!account) return { done: false as const, status: "missing" };
  if (account.status !== "provisioning") {
    return { done: true as const, status: account.status };
  }

  const metaId = await ensureCorrectMetaId(account);
  if (!metaId) {
    return { done: false as const, status: "provisioning" as const };
  }

  const st = await getMetaAccountStatus(metaId);
  // DISCONNECTED contains substring "CONNECTED" — never use includes()
  const conn = String(st.connectionStatus || "").toUpperCase();
  const connected =
    conn === "CONNECTED" || conn === "CONNECTED_NEW_ACCOUNT";

  // Only accept real broker connect + readable snapshot.
  if (st.state === "DEPLOYED" && connected) {
    const snap = await fetchSnapshot(metaId);
    if (snap.ok && (snap.balance > 0 || snap.equity > 0 || snap.login || snap.leverage > 0)) {
      await markLinked(account.id, snap);
      return { done: true as const, status: "connected" as const };
    }
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        metaApiAccountId: metaId,
        statusMessage: "브로커 연결됨 · 잔고 동기화 대기 중…",
      },
    });
    return { done: false as const, status: "provisioning" as const, message: snap.ok ? "empty snap" : snap.message };
  }

  if (st.state === "DEPLOY_FAILED") {
    const msg = toKoreanError(st.raw, "브로커 연결에 실패했습니다. 계좌 정보를 확인하세요.");
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { status: "failed", statusMessage: msg, botEnabled: false },
    });
    return { done: true as const, status: "failed" as const, message: msg };
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      metaApiAccountId: metaId,
      statusMessage: "브로커 연결 진행 중… 보통 1~2분 걸립니다.",
    },
  });
  return { done: false as const, status: "provisioning" as const };
}

export async function finalizeAllProvisioning() {
  const list = await prisma.brokerAccount.findMany({
    where: { status: "provisioning" },
    select: { id: true },
  });
  const settled = await Promise.all(
    list.map(async (a) => ({ id: a.id, ...(await finalizeProvisionIfReady(a.id)) })),
  );
  await prisma.brokerAccount.updateMany({
    where: {
      status: "provisioning",
      metaApiAccountId: null,
      updatedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
    },
    data: {
      status: "failed",
      statusMessage: "연동 시간이 초과되었습니다. 다시 승인해주세요.",
    },
  });
  return settled;
}

/**
 * Admin approve: prove CONNECTED + live snapshot, keep cloud DEPLOYED.
 * Retries rate-limits; never soft-links a DISCONNECTED cloud.
 */
export async function runAdminProvision(accountId: string) {
  const account = await prisma.brokerAccount.findUnique({ where: { id: accountId } });
  if (!account) return { ok: false as const, error: "계좌를 찾을 수 없습니다." };
  if (!account.syncToken) {
    return {
      ok: false as const,
      error: "저장된 MT5 비밀번호가 없습니다. 회원에게 다시 연결을 요청하세요.",
    };
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: { status: "provisioning", statusMessage: "비밀번호·브로커 검증 중…" },
  });

  const { ensureAccountCloudLive } = await import("./metaapi");

  let repaired = await ensureAccountCloudLive({
    metaApiAccountId: account.metaApiAccountId,
    login: account.login,
    password: account.syncToken,
    server: account.server,
    waitMs: 90000,
    allowRecreate: true,
  });

  if (!repaired.ok && /너무 많|rate|429/i.test(repaired.message)) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: { statusMessage: "요청 제한 · 잠시 후 재시도 중…" },
    });
    await new Promise((r) => setTimeout(r, 65000));
    repaired = await ensureAccountCloudLive({
      metaApiAccountId: account.metaApiAccountId,
      login: account.login,
      password: account.syncToken,
      server: account.server,
      waitMs: 90000,
      allowRecreate: true,
    });
  }

  if (!repaired.ok) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        status: "failed",
        statusMessage: repaired.message,
        botEnabled: false,
      },
    });
    return { ok: false as const, error: repaired.message };
  }

  const metaId = String(repaired.metaApiAccountId);
  const balance = repaired.snap.balance;
  const equity = repaired.snap.equity;

  if (!(balance > 0 || equity > 0 || repaired.snap.login || repaired.snap.leverage > 0)) {
    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        status: "failed",
        statusMessage: "브로커 계좌 정보를 확인하지 못했습니다. 비밀번호·서버명을 확인하세요.",
        botEnabled: false,
      },
    });
    return {
      ok: false as const,
      error: "브로커 계좌 정보를 확인하지 못했습니다. 비밀번호·서버명을 확인하세요.",
    };
  }

  // Keep DEPLOYED — do not undeploy on approve (instant bot start for scale)
  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      metaApiAccountId: metaId,
      status: "connected",
      mode: "live",
      balance,
      equity,
      startingBalance:
        account.startingBalance > 0
          ? account.startingBalance
          : balance > 0
            ? balance
            : account.startingBalance,
      lastSyncAt: new Date(),
      botEnabled: false,
      botStoppedAt: new Date(),
      statusMessage:
        "연동 완료 · 클라우드 연결됨. 앱에서 전체 시작을 누르면 봇이 실행됩니다.",
    },
  });

  return {
    ok: true as const,
    pending: false,
    message: `계좌 연동 완료 · 평가금액 $${equity.toFixed(2)} · 클라우드 연결 유지`,
    status: "connected" as const,
  };
}
