import { prisma } from "./db";
import { toKoreanError } from "./ko-errors";
import {
  deployAccount,
  fetchSnapshot,
  findMetaAccountByLogin,
  getMetaAccountStatus,
  startCloudAccount,
} from "./metaapi";

function looksLikeUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
}

async function markLinked(
  accountId: string,
  snap: { metaApiAccountId: string; balance: number; equity: number },
) {
  const metaId = String(snap.metaApiAccountId);
  // Undeploy after link — no MetaAPI burn until user starts the trading bot
  try {
    const { undeployAccount } = await import("./metaapi");
    await undeployAccount(metaId);
  } catch {
    /* ignore */
  }
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      metaApiAccountId: metaId,
      status: "undeployed",
      statusMessage:
        "연동 완료 · 클라우드 대기(비용 절감). 봇을 시작하면 API가 활성화됩니다.",
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
  const connected =
    st.connectionStatus === "CONNECTED" ||
    st.connectionStatus === "CONNECTED_NEW_ACCOUNT" ||
    (st.state === "DEPLOYED" && String(st.connectionStatus).toUpperCase().includes("CONNECTED"));

  if (connected || st.state === "DEPLOYED") {
    // DEPLOYED is enough — fetch snapshot (may work even if status wording differs)
    const snap = await fetchSnapshot(metaId);
    if (snap.ok) {
      await markLinked(account.id, snap);
      return { done: true as const, status: "connected" as const };
    }
    // Connected in MetaAPI UI but snapshot failed — still mark linked with zeros
    if (connected || st.state === "DEPLOYED") {
      await markLinked(account.id, {
        metaApiAccountId: metaId,
        balance: account.balance,
        equity: account.equity,
      });
      return { done: true as const, status: "connected" as const };
    }
    return { done: false as const, status: "provisioning" as const, message: snap.message };
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
  const out = [];
  for (const a of list) {
    out.push({ id: a.id, ...(await finalizeProvisionIfReady(a.id)) });
  }
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
  return out;
}

/**
 * Admin approve: create cloud immediately, save id, short poll, then return pending if needed.
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
    data: { status: "provisioning", statusMessage: "클라우드 계좌 확인 중…" },
  });

  // Always resolve existing MetaAPI account by MT5 login first
  let metaId = await ensureCorrectMetaId(account);

  if (!metaId || !looksLikeUuid(metaId)) {
    const started = await startCloudAccount({
      login: account.login,
      password: account.syncToken,
      server: account.server,
    });
    if (!started.ok) {
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: { status: "failed", statusMessage: started.message },
      });
      return { ok: false as const, error: started.message };
    }
    metaId = String(started.metaApiAccountId);
  } else {
    await deployAccount(metaId).catch(() => null);
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      metaApiAccountId: metaId,
      status: "provisioning",
      statusMessage: "브로커 연결 확인 중…",
    },
  });

  for (let i = 0; i < 5; i++) {
    const fin = await finalizeProvisionIfReady(account.id);
    if (fin.done) {
      if (fin.status === "failed") {
        return { ok: false as const, error: fin.message || "연동에 실패했습니다." };
      }
      return {
        ok: true as const,
        pending: false,
        message: "계좌 연동이 완료되었습니다. 대시보드에서 실계좌가 동기화됩니다.",
        status: fin.status,
      };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  return {
    ok: true as const,
    pending: true,
    message: "브로커 연결 확인 중입니다. 화면이 자동으로 갱신됩니다.",
    status: "provisioning",
  };
}
