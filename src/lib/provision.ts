import { prisma } from "./db";
import {
  isMt5AuthError,
  isNetworkTransientError,
  isRateLimitError,
  toKoreanError,
} from "./ko-errors";
import {
  fetchSnapshot,
  findMetaAccountByLogin,
  getMetaAccountStatus,
} from "./metaapi";

function looksLikeUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const AUTH_FAIL_MSG = "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.";

/** Transient MetaAPI provisioning / deploy rate limits — never permanent fail. */
export function isProvisionRateLimitMessage(msg: unknown): boolean {
  if (isRateLimitError(msg)) return true;
  const t = String(msg || "");
  return /요청 제한|요청이 너무 많|rate\s*limit|rate_limit|too many|429/i.test(t);
}

/** Soft-retryable provision errors (not wrong password). */
export function isProvisionTransientMessage(msg: unknown): boolean {
  if (isMt5AuthError(msg)) return false;
  const t = String(msg || "");
  if (/브로커 계좌 검증 중|validation is in progress|1분 후 다시 시도/i.test(t)) {
    return true;
  }
  return isProvisionRateLimitMessage(msg) || isNetworkTransientError(msg);
}

export function isProvisionAuthMessage(msg: unknown): boolean {
  return isMt5AuthError(msg);
}

/** Admin poll / finalize must not re-hit MetaAPI create more than once per few minutes. */
const PROVISION_RETRY_COOLDOWN_MS = 180_000;

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
    // No cloud id yet — retry create/deploy, but cooldown so admin 5s poll does not hammer MetaAPI.
    if (account.syncToken) {
      const ageMs = Date.now() - new Date(account.updatedAt).getTime();
      if (ageMs >= PROVISION_RETRY_COOLDOWN_MS) {
        const again = await runAdminProvision(account.id);
        if (again.ok && !again.pending) {
          return { done: true as const, status: "connected" as const };
        }
        return {
          done: false as const,
          status: "provisioning" as const,
          message: again.ok ? again.message : again.error,
        };
      }
      return {
        done: false as const,
        status: "provisioning" as const,
        message: account.statusMessage || "요청 제한 · 자동 재시도 대기 중…",
      };
    }
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
        statusMessage: isProvisionRateLimitMessage(snap.ok ? "" : snap.message)
          ? "요청 제한 · 자동 재시도 중…"
          : "브로커 연결됨 · 잔고 동기화 대기 중…",
      },
    });
    return {
      done: false as const,
      status: "provisioning" as const,
      message: snap.ok ? "empty snap" : snap.message,
    };
  }

  if (st.state === "DEPLOY_FAILED") {
    const msg = toKoreanError(st.raw, "브로커 연결에 실패했습니다. 계좌 정보를 확인하세요.");
    // Auth/server errors are permanent; rate-limit-ish deploy noise stays provisioning.
    if (isProvisionRateLimitMessage(msg) || isProvisionRateLimitMessage(st.raw)) {
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          metaApiAccountId: metaId,
          status: "provisioning",
          statusMessage: "요청 제한 · 자동 재시도 중…",
        },
      });
      return { done: false as const, status: "provisioning" as const, message: msg };
    }
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
  // Recover accounts wrongly marked failed solely due to MetaAPI 429 / network blips.
  await prisma.brokerAccount.updateMany({
    where: {
      status: "failed",
      OR: [
        { statusMessage: { contains: "요청 제한" } },
        { statusMessage: { contains: "요청이 너무 많" } },
        { statusMessage: { contains: "rate" } },
        { statusMessage: { contains: "429" } },
        { statusMessage: { contains: "네트워크 연결이 불안정" } },
        { statusMessage: { contains: "NETWORK" } },
      ],
      NOT: [
        { statusMessage: { contains: "비밀번호가 올바르지" } },
        { statusMessage: { contains: "계좌번호 또는 비밀번호" } },
      ],
    },
    data: {
      status: "provisioning",
      statusMessage: "일시 오류 · 자동 재시도 중…",
    },
  });

  const list = await prisma.brokerAccount.findMany({
    where: { status: "provisioning" },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: 8,
  });
  // Serialize — parallel finalize/provision bursts MetaAPI provisioning API into 429.
  const settled: Array<{ id: string } & Awaited<ReturnType<typeof finalizeProvisionIfReady>>> =
    [];
  for (const a of list) {
    settled.push({ id: a.id, ...(await finalizeProvisionIfReady(a.id)) });
  }

  // Only time-out provisioning that never got a MetaAPI id (true stuck), not soft waits.
  await prisma.brokerAccount.updateMany({
    where: {
      status: "provisioning",
      metaApiAccountId: null,
      updatedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
      NOT: [
        { statusMessage: { contains: "요청 제한" } },
        { statusMessage: { contains: "요청이 너무 많" } },
        { statusMessage: { contains: "자동 재시도" } },
        { statusMessage: { contains: "네트워크" } },
        { statusMessage: { contains: "일시 오류" } },
      ],
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
 * Rate limits stay in provisioning + auto-retry — never permanent failed.
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

  // Keep in-request retries short: Vercel serverless budgets + admin polls check_provision.
  const maxAttempts = 2;
  let repaired: Awaited<ReturnType<typeof ensureAccountCloudLive>> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    repaired = await ensureAccountCloudLive({
      metaApiAccountId: account.metaApiAccountId,
      login: account.login,
      password: account.syncToken,
      server: account.server,
      waitMs: 90000,
      allowRecreate: true,
    });

    if (repaired.ok) break;

    if (isProvisionAuthMessage(repaired.message)) {
      break;
    }
    if (!isProvisionTransientMessage(repaired.message)) {
      break;
    }

    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        status: "provisioning",
        statusMessage: isProvisionRateLimitMessage(repaired.message)
          ? `요청 제한 · 재시도 ${attempt}/${maxAttempts}…`
          : `일시 오류 · 재시도 ${attempt}/${maxAttempts}…`,
        botEnabled: false,
      },
    });
    if (attempt < maxAttempts) {
      await sleep(8_000 * attempt);
    }
  }

  if (!repaired || !repaired.ok) {
    const rawMsg = repaired?.message || "계좌 연동에 실패했습니다.";
    if (isProvisionAuthMessage(rawMsg)) {
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          status: "failed",
          statusMessage: AUTH_FAIL_MSG,
          botEnabled: false,
        },
      });
      return { ok: false as const, error: AUTH_FAIL_MSG };
    }
    if (isProvisionTransientMessage(rawMsg)) {
      const softMsg = isProvisionRateLimitMessage(rawMsg)
        ? "요청 제한 · 자동 재시도 대기 중… (실패로 표시하지 않음)"
        : "네트워크 일시 오류 · 자동 재시도 대기 중… (실패로 표시하지 않음)";
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          status: "provisioning",
          statusMessage: softMsg,
          botEnabled: false,
        },
      });
      return {
        ok: true as const,
        pending: true,
        message: softMsg,
        status: "provisioning" as const,
      };
    }

    await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        status: "failed",
        statusMessage: toKoreanError(rawMsg, rawMsg),
        botEnabled: false,
      },
    });
    return { ok: false as const, error: toKoreanError(rawMsg, rawMsg) };
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
