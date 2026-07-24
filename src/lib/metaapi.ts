/**
 * MetaAPI cloud — provision, deploy/undeploy, sync, trade.
 * Defaults to cloud-g1 + regular (works without high-reliability top-up).
 * Falls back automatically if a preferred mode fails.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { isRateLimitError, isTopUpOrHighReliabilityError, toKoreanError } from "./ko-errors";

const PROVISIONING =
  process.env.METAAPI_PROVISIONING_URL ||
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

const REGION = process.env.METAAPI_REGION || "london";

function clientBase(region = REGION) {
  return (
    process.env.METAAPI_CLIENT_URL ||
    `https://mt-client-api-v1.${region}.agiliumtrade.ai`
  );
}

/** Trade/close/modify must hit the account's MetaAPI region (snap already does). */
async function tradeApiBase(metaApiAccountId: string) {
  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  return clientBase(region || REGION);
}

/** Prefer account region, then common MetaAPI regions (this project uses london g2). */
function clientApiBases(preferredRegion?: string | null) {
  const regions = [
    preferredRegion,
    process.env.METAAPI_REGION,
    "london",
    "new-york",
  ].filter(Boolean) as string[];
  const urls: string[] = [];
  if (process.env.METAAPI_CLIENT_URL) urls.push(process.env.METAAPI_CLIENT_URL);
  for (const r of regions) {
    const u = `https://mt-client-api-v1.${r}.agiliumtrade.ai`;
    if (!urls.includes(u)) urls.push(u);
  }
  const fallback = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";
  if (!urls.includes(fallback)) urls.push(fallback);
  return urls;
}

const metaRegionCache = new Map<string, string>();
const metaRegionCacheAt = new Map<string, number>();
const REGION_CACHE_TTL_MS = 30 * 60_000;

/** Soft hint only — never overrides a fresh MetaAPI-resolved region. */
export function primeMetaRegionCache(
  metaApiAccountId: string,
  region: string | null | undefined,
) {
  const r = (region || "").trim().toLowerCase();
  if (!metaApiAccountId || !r) return;
  const id = String(metaApiAccountId);
  const at = metaRegionCacheAt.get(id) || 0;
  // Do not overwrite a recently verified live region with possibly-stale DB
  if (metaRegionCache.has(id) && Date.now() - at < REGION_CACHE_TTL_MS) return;
  metaRegionCache.set(id, r);
  // Mark as soft (old) so next resolve refreshes from MetaAPI soon
  metaRegionCacheAt.set(id, Date.now() - REGION_CACHE_TTL_MS + 60_000);
}

export function clearMetaRegionCache(metaApiAccountId?: string) {
  if (!metaApiAccountId) {
    metaRegionCache.clear();
    metaRegionCacheAt.clear();
    return;
  }
  const id = String(metaApiAccountId);
  metaRegionCache.delete(id);
  metaRegionCacheAt.delete(id);
}

async function resolveAccountRegion(metaApiAccountId: string): Promise<string | null> {
  const id = String(metaApiAccountId);
  const cached = metaRegionCache.get(id);
  const at = metaRegionCacheAt.get(id) || 0;
  if (cached && Date.now() - at < REGION_CACHE_TTL_MS) return cached;

  const st = await getMetaAccountStatus(id);
  const region =
    st.raw && typeof st.raw === "object"
      ? String((st.raw as { region?: string }).region || "").toLowerCase()
      : "";
  if (region) {
    metaRegionCache.set(id, region);
    metaRegionCacheAt.set(id, Date.now());
    return region;
  }
  return cached || null;
}

/** Resolve live MetaAPI region into cache (caller may persist to DB). */
export async function refreshAccountRegion(
  metaApiAccountId: string,
): Promise<string | null> {
  clearMetaRegionCache(metaApiAccountId);
  return resolveAccountRegion(metaApiAccountId);
}

function newTransactionId() {
  return randomBytes(16).toString("hex");
}

function token() {
  return process.env.METAAPI_TOKEN?.trim() || "";
}

export type MetaSnap = {
  ok: true;
  metaApiAccountId: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  currency: string;
  name: string;
  server: string;
  login: string;
  connectionStatus?: string;
  positions: Array<{
    id: string;
    symbol: string;
    direction: "BUY" | "SELL";
    lots: number;
    price: number;
    profit: number;
    /** MetaAPI/브로커 포지션 사용증거금 (있으면 바스켓 ROI 분모 우선) */
    margin?: number;
    magic?: number;
    /** 브로커 지정 손절가 (없으면 0/미설정) */
    stopLoss?: number;
    /** 브로커 지정 익절가 (없으면 0/미설정) */
    takeProfit?: number;
  }>;
};

export type MetaErr = {
  ok: false;
  code: string;
  message: string;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function api(
  base: string,
  method: string,
  pathName: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const t = token();
  if (!t) {
    return {
      status: 503,
      data: {
        message: "MetaAPI 토큰이 설정되지 않았습니다. 관리자에게 문의하세요.",
        details: "NO_TOKEN",
      },
    };
  }

  const maxAttempts = 3;
  let lastStatus = 0;
  let lastData: unknown = null;

  // Also reduce retries on abort so connect never stalls minutes
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let res: Response;
      try {
        res = await fetch(`${base}${pathName}`, {
          method,
          headers: {
            "auth-token": t,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...extraHeaders,
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text, message: text };
      }
      lastStatus = res.status;
      lastData = data;

      try {
        const { recordMetaApiHttp } = await import("./metaapi-metrics");
        recordMetaApiHttp({ method, pathName, status: res.status });
      } catch {
        /* metrics optional */
      }

      // 429: do not retry here — burns MetaAPI credits further; caller backs off
      const retryable = res.status === 503 || res.status === 502;
      if (retryable && attempt < maxAttempts) {
        const ra = res.headers.get("retry-after");
        const parsed = ra ? Number(ra) * 1000 : NaN;
        // Provisioning/rate storms need longer waits than trade ticks
        const cap = Number(process.env.METAAPI_RETRY_CAP_MS || 30_000);
        const backoff = Number.isFinite(parsed)
          ? Math.min(parsed, cap)
          : Math.min(1000 * 2 ** attempt, cap);
        await sleep(backoff);
        continue;
      }
      return { status: res.status, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network";
      lastStatus = 0;
      lastData = { message: msg, details: "NETWORK" };
      try {
        const { recordMetaApiHttp } = await import("./metaapi-metrics");
        recordMetaApiHttp({ method, pathName, status: 0 });
      } catch {
        /* ignore */
      }
      // Abort / fetch failed: at most 2 quick retries
      if (attempt < Math.min(maxAttempts, 2)) {
        await sleep(600 * attempt);
        continue;
      }
      return {
        status: 503,
        data: {
          message: "네트워크 연결이 불안정합니다. 잠시 후 다시 시도하세요.",
          details: "NETWORK",
        },
      };
    }
  }

  return { status: lastStatus || 503, data: lastData };
}

function errCode(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  if (typeof d.details === "string") return d.details;
  if (d.details && typeof d.details === "object") {
    const c = (d.details as { code?: string }).code;
    if (c) return c;
  }
  if (typeof d.error === "string") return d.error;
  return "";
}

async function ensureProvisioningProfile(): Promise<string | undefined> {
  const existing = process.env.METAAPI_PROFILE_ID?.trim();
  if (existing) return existing;

  const list = await api(PROVISIONING, "GET", "/users/current/provisioning-profiles");
  if (list.status === 200 && Array.isArray(list.data)) {
    const found = (list.data as Array<{ _id?: string; id?: string; name?: string }>).find(
      (p) => p.name === "SuperAlpha-ZeroMarkets",
    );
    const id = found?._id || found?.id;
    if (id) return id;
  }

  const created = await api(PROVISIONING, "POST", "/users/current/provisioning-profiles", {
    name: "SuperAlpha-ZeroMarkets",
    version: 5,
    brokerTimezone: "EET",
    brokerDSTSwitchTimezone: "EET",
  });
  if (created.status >= 400) return undefined;

  const profileId =
    (created.data as { id?: string; _id?: string })?.id ||
    (created.data as { id?: string; _id?: string })?._id;
  if (!profileId) return undefined;

  try {
    const datPath = path.join(process.cwd(), "metaapi", "servers.dat");
    if (fs.existsSync(datPath)) {
      const buf = fs.readFileSync(datPath);
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "application/octet-stream" }), "servers.dat");
      await fetch(
        `${PROVISIONING}/users/current/provisioning-profiles/${profileId}/servers.dat`,
        { method: "PUT", headers: { "auth-token": token() }, body: form },
      );
    }
  } catch {
    /* optional */
  }
  return profileId;
}

export async function getMetaAccountStatus(metaApiAccountId: string) {
  const res = await api(PROVISIONING, "GET", `/users/current/accounts/${metaApiAccountId}`);
  const d = (res.data || {}) as {
    state?: string;
    connectionStatus?: string;
    message?: string;
  };
  return {
    status: res.status,
    state: d.state || "",
    connectionStatus: d.connectionStatus || "",
    raw: res.data,
  };
}

function pickMetaAccountId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const candidates = [d._id, d.id, d.accountId].map((v) =>
    v == null ? "" : String(v),
  );
  // Prefer UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  const uuid = candidates.find((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(c));
  if (uuid) return uuid;
  return candidates.find((c) => c.length > 0) || "";
}

export async function listMetaAccounts(): Promise<
  Array<{
    id: string;
    login: string;
    name: string;
    state: string;
    connectionStatus: string;
    type?: string;
    reliability?: string;
  }>
> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await api(PROVISIONING, "GET", "/users/current/accounts");
    if (res.status === 429 || isRateLimitError(res.data)) {
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status >= 400 || !Array.isArray(res.data)) return [];
    return (res.data as unknown[]).map((raw) => {
      const x = raw as Record<string, unknown>;
      return {
        id: pickMetaAccountId(raw),
        login: String(x.login || ""),
        name: String(x.name || ""),
        state: String(x.state || ""),
        connectionStatus: String(x.connectionStatus || ""),
        type: x.type != null ? String(x.type) : undefined,
        reliability: x.reliability != null ? String(x.reliability) : undefined,
      };
    });
  }
  return [];
}

/** Optional pin: METAAPI_PINNED_LOGINS=130063934:uuid,another:uuid */
function pinnedMetaIdForLogin(login: string): string | null {
  const raw = process.env.METAAPI_PINNED_LOGINS?.trim();
  if (!raw) return null;
  const want = loginDigits(login);
  for (const part of raw.split(",")) {
    const [lg, id] = part.split(":").map((s) => s.trim());
    if (lg && id && loginDigits(lg) === want) return id;
  }
  return null;
}

function loginDigits(s: string) {
  return String(s || "").replace(/\D/g, "");
}

function isMetaConnectedStatus(connectionStatus: string) {
  const s = String(connectionStatus || "").toUpperCase();
  // DISCONNECTED contains substring "CONNECTED" — never use includes()
  return s === "CONNECTED" || s === "CONNECTED_NEW_ACCOUNT";
}

function metaAccountScore(a: {
  state: string;
  connectionStatus: string;
  type?: string;
}) {
  const conn = a.connectionStatus.toUpperCase();
  let s = 0;
  if (a.state === "DEPLOYED") s += 10;
  if (isMetaConnectedStatus(conn)) s += 20;
  if (conn.includes("FULL") && isMetaConnectedStatus(conn)) s += 5;
  if (a.type?.includes("g2")) s += 1;
  return s;
}

/** All MetaAPI cloud accounts matching this MT5 login (handles MT5- prefix / SA- name). */
export async function findAllMetaAccountsByLogin(login: string) {
  const want = loginDigits(login);
  if (!want) return [];
  const list = await listMetaAccounts();
  return list
    .filter(
      (a) =>
        !!a.id &&
        (loginDigits(a.login) === want ||
          a.name === `SA-${want}` ||
          a.name.includes(want) ||
          a.login.includes(want)),
    )
    .sort((a, b) => metaAccountScore(b) - metaAccountScore(a));
}

/** Best already-created MetaAPI account for this MT5 login. */
export async function findMetaAccountByLogin(login: string) {
  const matches = await findAllMetaAccountsByLogin(login);
  return matches[0] || null;
}

/** In-process lock so parallel connect retries cannot create duplicate clouds. */
const provisionLocks = new Map<string, Promise<MetaSnap | MetaErr>>();

/**
 * Create + deploy only (no long wait). Caller saves id then polls.
 */
export async function startCloudAccount(input: {
  login: string;
  password: string;
  server: string;
}): Promise<{ ok: true; metaApiAccountId: string } | MetaErr> {
  if (!token()) {
    return {
      ok: false,
      code: "NO_TOKEN",
      message: "MetaAPI 토큰이 설정되지 않았습니다. 관리자에게 문의하세요.",
    };
  }

  // Reuse if already registered in MetaAPI (avoids duplicate + stuck provisioning)
  const existing = await findMetaAccountByLogin(input.login);
  if (existing?.id) {
    return { ok: true, metaApiAccountId: existing.id };
  }

  const profileId = await ensureProvisioningProfile();
  const modes = provisionModes();
  let lastErr: MetaErr | null = null;

  for (const mode of modes) {
    // Re-check every loop — never create a second cloud for same login
    const again0 = await findMetaAccountByLogin(input.login);
    if (again0?.id) return { ok: true, metaApiAccountId: again0.id };

    const payload: Record<string, unknown> = {
      name: `SA-${input.login}`,
      type: mode.type,
      login: input.login,
      password: input.password,
      server: input.server,
      platform: "mt5",
      magic: 20260714,
      quoteStreamingIntervalInSeconds: 2.5,
      reliability: mode.reliability,
      region: REGION,
    };
    if (profileId) payload.provisioningProfileId = profileId;

    const created = await api(PROVISIONING, "POST", "/users/current/accounts", payload, {
      "transaction-id": newTransactionId(),
    });

    if (created.status >= 400 || created.status === 0) {
      const code = errCode(created.data);
      const again = await findMetaAccountByLogin(input.login);
      if (again?.id) {
        return { ok: true, metaApiAccountId: again.id };
      }
      lastErr = {
        ok: false,
        code: code || (created.status === 0 ? "NETWORK" : "CREATE_FAILED"),
        message: toKoreanError(created.data, "클라우드 계좌 생성에 실패했습니다."),
      };
      if (code === "E_AUTH") {
        return {
          ok: false,
          code: "E_AUTH",
          message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
        };
      }
      if (isTopUpOrHighReliabilityError(created.data)) continue;
      break;
    }

    const accountId = pickMetaAccountId(created.data);
    if (!accountId) {
      lastErr = { ok: false, code: "UNKNOWN", message: "클라우드 계좌 ID를 받지 못했습니다." };
      continue;
    }

    // Do not deploy here — deploy only when bot starts (cost save)
    return { ok: true, metaApiAccountId: accountId };
  }

  // Last resort: list by login
  const fallback = await findMetaAccountByLogin(input.login);
  if (fallback?.id) {
    return { ok: true, metaApiAccountId: fallback.id };
  }

  return (
    lastErr || {
      ok: false,
      code: "UNKNOWN",
      message: "클라우드 계좌 생성에 실패했습니다. MetaAPI 잔액·구독을 확인하세요.",
    }
  );
}

export async function waitUntilConnected(accountId: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(PROVISIONING, "GET", `/users/current/accounts/${accountId}`);
    const d = (res.data || {}) as Record<string, unknown>;
    const state = String(d.state || "");
    const connectionStatus = String(d.connectionStatus || "").toUpperCase();
    const code = errCode(res.data);
    const blob = JSON.stringify(res.data || {}).toLowerCase();

    if (
      code === "E_AUTH" ||
      blob.includes("e_auth") ||
      blob.includes("invalid account") ||
      blob.includes("invalid password") ||
      blob.includes("authentication failed")
    ) {
      return {
        ok: false as const,
        code: "E_AUTH",
        message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
      };
    }

    // 주의: "DISCONNECTED".includes("CONNECTED") === true 이므로 부분문자열 검사 금지
    const connected = isMetaConnectedStatus(connectionStatus);

    if (state === "DEPLOYED" && connected) {
      return { ok: true as const };
    }
    if (state === "DEPLOY_FAILED") {
      return {
        ok: false as const,
        code: code || "DEPLOY_FAILED",
        message: toKoreanError(
          res.data,
          code === "E_AUTH"
            ? "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다."
            : "브로커 서버 연결에 실패했습니다.",
        ),
      };
    }
    await sleep(2000);
  }
  return {
    ok: false as const,
    code: "TIMEOUT",
    message:
      "브로커 클라우드 연결 시간이 초과되었습니다. MT5 비밀번호·서버명을 확인한 뒤 다시 시도해주세요.",
  };
}

/**
 * Update credentials on an existing MetaAPI cloud and prove the password works.
 * Wrong password → E_AUTH. Never soft-succeed without broker proof.
 */
async function verifyPasswordOnExistingAccount(input: {
  metaApiAccountId: string;
  login: string;
  password: string;
  server: string;
  name?: string;
}): Promise<MetaSnap | MetaErr> {
  const id = String(input.metaApiAccountId);

  const updated = await api(PROVISIONING, "PUT", `/users/current/accounts/${id}`, {
    password: input.password,
    login: input.login,
    name: `SA-${input.login}`,
    server: input.server,
  });

  if (updated.status === 429 || isRateLimitError(updated.data)) {
    return {
      ok: false,
      code: "RATE_LIMIT",
      message: "요청이 너무 많습니다. 1분 후 다시 시도하세요.",
    };
  }

  const updateCode = errCode(updated.data);
  const updateBlob = JSON.stringify(updated.data || {}).toLowerCase();
  if (
    updateCode === "E_AUTH" ||
    updateBlob.includes("e_auth") ||
    updateBlob.includes("invalid password") ||
    updateBlob.includes("invalid account") ||
    (updated.status === 401 && !isRateLimitError(updated.data))
  ) {
    return {
      ok: false,
      code: "E_AUTH",
      message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
    };
  }

  if (updated.status === 0 || updated.status >= 400) {
    // Still try deploy — some PUT responses are noisy but deploy reveals E_AUTH
  }

  await deployAccount(id);
  const waited = await waitUntilConnected(id, 60000);

  if (!waited.ok) {
    if (waited.code === "E_AUTH") {
      void undeployAccount(id).catch(() => null);
      return {
        ok: false,
        code: "E_AUTH",
        message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
      };
    }

    // Snapshot success = credentials accepted by broker
    const snap = await fetchSnapshot(id);
    if (snap.ok) {
      void undeployAccount(id).catch(() => null);
      return snap;
    }

    void undeployAccount(id).catch(() => null);
    if (waited.code === "TIMEOUT") {
      return {
        ok: false,
        code: "TIMEOUT",
        message: "비밀번호 검증에 시간이 초과되었습니다. 잠시 후 다시 시도하세요.",
      };
    }
    return {
      ok: false,
      code: waited.code || "DEPLOY_FAILED",
      message: toKoreanError(waited.message, "계좌 검증에 실패했습니다."),
    };
  }

  const snap = await fetchSnapshot(id);
  if (snap.ok) {
    void undeployAccount(id).catch(() => null);
    return snap;
  }

  // Connected but snapshot slow — retry before accepting empty balances
  for (let i = 0; i < 5; i++) {
    await sleep(2500);
    const again = await fetchSnapshot(id);
    if (again.ok) {
      void undeployAccount(id).catch(() => null);
      return again;
    }
  }

  void undeployAccount(id).catch(() => null);
  // Never soft-succeed without a readable broker snapshot
  return {
    ok: false,
    code: "TIMEOUT",
    message:
      "브로커 연결은 됐지만 계좌 정보를 읽지 못했습니다. 잠시 후 다시 시도해주세요.",
  };
}

/** Deploy + wait until MetaAPI reports CONNECTED and account-information works. */
export async function ensureCloudLive(metaApiAccountId: string, waitMs = 45000) {
  const id = String(metaApiAccountId);
  await deployAccount(id);
  const waited = await waitUntilConnected(id, waitMs);
  const st = await getMetaAccountStatus(id).catch(() => null);
  const connected = !!(st && isMetaConnectedStatus(st.connectionStatus));

  if (!waited.ok && !connected) {
    return {
      ok: false as const,
      code: (waited.code || "DISCONNECTED") as string,
      message:
        waited.code === "E_AUTH"
          ? waited.message
          : "MT5 클라우드가 브로커에 연결되지 않았습니다. 마이페이지에서 계좌를 다시 연결하거나, MT5 비밀번호(투자자 비번 아님)·서버명을 확인 후 다시 시도해주세요.",
    };
  }

  for (let i = 0; i < 6; i++) {
    const snap = await fetchSnapshot(id);
    if (snap.ok) {
      if (snap.login || snap.leverage > 0 || snap.balance > 0 || snap.equity > 0) {
        return { ok: true as const, snap };
      }
    }
    await sleep(2000);
  }
  return {
    ok: false as const,
    code: "TIMEOUT",
    message: "브로커 연결 후 계좌 정보를 읽지 못했습니다. 잠시 후 다시 시도해주세요.",
  };
}

/**
 * Keep/repair a live cloud. By default NEVER deletes MetaAPI accounts
 * (engine / bot ON must not wipe). Set allowRecreate for admin repair only.
 */
export async function ensureAccountCloudLive(input: {
  metaApiAccountId: string | null | undefined;
  login: string;
  password: string;
  server: string;
  waitMs?: number;
  /** Only admin/repair scripts — never true in engine tick while trading */
  allowRecreate?: boolean;
}): Promise<
  | { ok: true; snap: MetaSnap; metaApiAccountId: string }
  | { ok: false; message: string }
> {
  const waitMs = input.waitMs ?? 60000;
  const metaId = input.metaApiAccountId ? String(input.metaApiAccountId) : "";
  const allowRecreate = !!input.allowRecreate;

  if (metaId) {
    const live = await ensureCloudLive(metaId, waitMs);
    if (live.ok) return { ok: true, snap: live.snap, metaApiAccountId: metaId };

    await api(PROVISIONING, "PUT", `/users/current/accounts/${metaId}`, {
      password: input.password,
      login: input.login,
      server: input.server,
      name: `SA-${input.login}`,
    }).catch(() => null);
    const livePw = await ensureCloudLive(metaId, waitMs);
    if (livePw.ok) return { ok: true, snap: livePw.snap, metaApiAccountId: metaId };

    if (!allowRecreate) {
      return {
        ok: false,
        message:
          livePw.message ||
          "클라우드 재연결에 실패했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
      };
    }
  } else if (!allowRecreate) {
    return {
      ok: false,
      message: "클라우드 계좌가 없습니다. 관리자 연동 승인 후 다시 시도하세요.",
    };
  }

  const existing = await findAllMetaAccountsByLogin(input.login);
  for (const c of existing) {
    try {
      await undeployAccount(c.id);
    } catch {
      /* ignore */
    }
    await removeMetaAccount(c.id);
  }
  await sleep(4000);

  const profileId = await ensureProvisioningProfile();
  const created = await createAndConnect({
    login: input.login,
    password: input.password,
    server: input.server,
    profileId,
    mode: { type: "cloud-g2", reliability: "high", label: "고성능(g2)" },
  });
  if (!created.ok) return { ok: false, message: created.message };

  const newId = String(created.metaApiAccountId);
  await api(PROVISIONING, "PUT", `/users/current/accounts/${newId}`, {
    password: input.password,
    login: input.login,
    server: input.server,
    name: `SA-${input.login}`,
  }).catch(() => null);
  const live2 = await ensureCloudLive(newId, Math.max(waitMs, 70000));
  if (!live2.ok) return { ok: false, message: live2.message };
  return { ok: true, snap: live2.snap, metaApiAccountId: newId };
}


export async function deployAccount(metaApiAccountId: string) {
  return api(PROVISIONING, "POST", `/users/current/accounts/${metaApiAccountId}/deploy`);
}

export async function undeployAccount(metaApiAccountId: string) {
  return api(PROVISIONING, "POST", `/users/current/accounts/${metaApiAccountId}/undeploy`);
}

export async function removeMetaAccount(metaApiAccountId: string) {
  try {
    await api(PROVISIONING, "DELETE", `/users/current/accounts/${metaApiAccountId}`);
  } catch {
    /* ignore */
  }
}

type CloudMode = { type: "cloud-g1" | "cloud-g2"; reliability: "regular" | "high"; label: string };

/**
 * Default: cloud-g2/high (stable broker connect).
 * Set METAAPI_FORCE_G1=1 to use cheap g1 only.
 */
function provisionModes(): CloudMode[] {
  const g1: CloudMode = { type: "cloud-g1", reliability: "regular", label: "일반(g1)" };
  const g2: CloudMode = { type: "cloud-g2", reliability: "high", label: "고성능(g2)" };
  if (process.env.METAAPI_FORCE_G1 === "1") return [g1];
  // g2 first — some ZeroMarkets logins stay DISCONNECTED forever on g1
  return [g2, g1];
}

function softLinkSnap(
  input: { login: string; server: string },
  metaId: string,
  name?: string,
): MetaSnap {
  return {
    ok: true,
    metaApiAccountId: metaId,
    balance: 0,
    equity: 0,
    margin: 0,
    freeMargin: 0,
    leverage: 0,
    currency: "USD",
    name: name || `SA-${input.login}`,
    server: input.server,
    login: input.login,
    positions: [],
  };
}

async function createAndConnect(input: {
  login: string;
  password: string;
  server: string;
  profileId?: string;
  mode: CloudMode;
}): Promise<MetaSnap | MetaErr> {
  const already = await findMetaAccountByLogin(input.login);
  if (already?.id) {
    // Caller (provisionTradingAccount) must still verify CONNECTED + snapshot
    return softLinkSnap(input, already.id, already.name);
  }

  const payload: Record<string, unknown> = {
    name: `SA-${input.login}`,
    type: input.mode.type,
    login: input.login,
    password: input.password,
    server: input.server,
    platform: "mt5",
    magic: 20260714,
    quoteStreamingIntervalInSeconds: 2.5,
    reliability: input.mode.reliability,
    region: REGION,
  };
  if (input.profileId) payload.provisioningProfileId = input.profileId;

  let created = await api(PROVISIONING, "POST", "/users/current/accounts", payload, {
    "transaction-id": newTransactionId(),
  });
  // Account create must survive transient 429 — retry twice with backoff.
  for (
    let i = 0;
    i < 2 && (created.status === 429 || isRateLimitError(created.data));
    i++
  ) {
    noteMetaApiRateLimit(15_000);
    await sleep(5000 * (i + 1));
    created = await api(PROVISIONING, "POST", "/users/current/accounts", payload, {
      "transaction-id": newTransactionId(),
    });
  }

  if (created.status === 0 || created.status >= 400) {
    const found = await findMetaAccountByLogin(input.login);
    if (found?.id) return softLinkSnap(input, found.id, found.name);
    if (created.status === 429 || isRateLimitError(created.data)) {
      return {
        ok: false,
        code: "RATE_LIMIT",
        message: "요청이 너무 많습니다. 1분 후 다시 시도하세요.",
      };
    }
    if (created.status === 0 || created.status === 503) {
      return {
        ok: false,
        code: "NETWORK",
        message: toKoreanError(
          created.data,
          "네트워크 연결이 불안정합니다. 잠시 후 다시 시도하세요.",
        ),
      };
    }
    const code = errCode(created.data);
    if (isTopUpOrHighReliabilityError(created.data)) {
      return { ok: false, code: "TOP_UP", message: toKoreanError(created.data) };
    }
    // MetaAPI sometimes returns HTTP 401 for rate limit — never call that E_AUTH
    if (created.status === 401 && isRateLimitError(created.data)) {
      return {
        ok: false,
        code: "RATE_LIMIT",
        message: "요청이 너무 많습니다. 1분 후 다시 시도하세요.",
      };
    }
    return {
      ok: false,
      code: code || "CREATE_FAILED",
      message: toKoreanError(created.data, "클라우드 계좌 생성에 실패했습니다."),
    };
  }

  const accountId = pickMetaAccountId(created.data);
  if (!accountId) {
    const found = await findMetaAccountByLogin(input.login);
    if (found?.id) return softLinkSnap(input, found.id, found.name);
    return { ok: false, code: "UNKNOWN", message: "클라우드 계좌 ID를 받지 못했습니다." };
  }

  // Do not await deploy during connect — hang risk; bot start will deploy
  void deployAccount(accountId).catch(() => null);
  return softLinkSnap(input, accountId);
}

/**
 * Idempotent MetaAPI link: reuse existing SA-{login} clouds; create at most one cheap g1.
 */
export async function provisionTradingAccount(input: {
  login: string;
  password: string;
  server: string;
  reuseAccountId?: string | null;
}): Promise<MetaSnap | MetaErr> {
  const lockKey = loginDigits(input.login) || input.login;
  const running = provisionLocks.get(lockKey);
  if (running) return running;

  const job = (async (): Promise<MetaSnap | MetaErr> => {
    try {
      if (!token()) {
        return {
          ok: false,
          code: "NO_TOKEN",
          message: "MetaAPI 토큰이 설정되지 않았습니다. 관리자에게 문의하세요.",
        };
      }

      const existingList = await findAllMetaAccountsByLogin(input.login);
      const pinned = pinnedMetaIdForLogin(input.login);
      const reuseId =
        (input.reuseAccountId && String(input.reuseAccountId)) ||
        (existingList[0]?.id ? String(existingList[0].id) : "") ||
        pinned ||
        "";

      if (reuseId) {
        return verifyPasswordOnExistingAccount({
          metaApiAccountId: reuseId,
          login: input.login,
          password: input.password,
          server: input.server,
          name: existingList[0]?.name,
        });
      }

      const profileId = await ensureProvisioningProfile();
      const modes = provisionModes();
      let lastErr: MetaErr | null = null;

      for (const mode of modes) {
        const again = await findMetaAccountByLogin(input.login);
        if (again?.id) {
          return verifyPasswordOnExistingAccount({
            metaApiAccountId: again.id,
            login: input.login,
            password: input.password,
            server: input.server,
            name: again.name,
          });
        }

        const result = await createAndConnect({
          login: input.login,
          password: input.password,
          server: input.server,
          profileId,
          mode,
        });
        if (result.ok) {
          // New cloud: prove password via deploy (create alone is not enough)
          return verifyPasswordOnExistingAccount({
            metaApiAccountId: result.metaApiAccountId,
            login: input.login,
            password: input.password,
            server: input.server,
            name: result.name,
          });
        }

        lastErr = result;

        // Rate limit: never soft-link without password proof
        if (result.code === "RATE_LIMIT" || isRateLimitError(result.message) || isRateLimitError(result.code)) {
          await sleep(2000);
          const afterRl = await findMetaAccountByLogin(input.login);
          if (afterRl?.id) {
            return verifyPasswordOnExistingAccount({
              metaApiAccountId: afterRl.id,
              login: input.login,
              password: input.password,
              server: input.server,
              name: afterRl.name,
            });
          }
          return {
            ok: false,
            code: "RATE_LIMIT",
            message: "요청이 너무 많습니다. 1분 후 다시 시도하세요.",
          };
        }

        if (result.code === "E_AUTH") {
          return {
            ok: false,
            code: "E_AUTH",
            message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
          };
        }
        if (result.code === "E_SRV_NOT_FOUND") {
          return {
            ok: false,
            code: "E_SRV_NOT_FOUND",
            message: `서버 '${input.server}' 를 찾지 못했습니다. 서버명을 확인하세요.`,
          };
        }
        if (result.code !== "TOP_UP" && !isTopUpOrHighReliabilityError(result.message)) break;
      }

      const final = await findMetaAccountByLogin(input.login);
      if (final?.id) {
        return verifyPasswordOnExistingAccount({
          metaApiAccountId: final.id,
          login: input.login,
          password: input.password,
          server: input.server,
          name: final.name,
        });
      }

      return {
        ok: false,
        code: lastErr?.code || "NETWORK",
        message: toKoreanError(
          lastErr?.message,
          "계좌 연결에 실패했습니다. 잠시 후 다시 시도하세요.",
        ),
      };
    } catch (e) {
      return {
        ok: false,
        code: "NETWORK",
        message: toKoreanError(e, "계좌 연결에 실패했습니다. 잠시 후 다시 시도하세요."),
      };
    }
  })();

  provisionLocks.set(lockKey, job);
  try {
    return await job;
  } finally {
    provisionLocks.delete(lockKey);
  }
}

function mapPositions(raw: unknown[]): MetaSnap["positions"] {
  return raw.map((p) => {
    const x = p as Record<string, unknown>;
    const type = String(x.type || x.positionType || "");
    const direction: "BUY" | "SELL" =
      type.toLowerCase().includes("sell") || type === "POSITION_TYPE_SELL" ? "SELL" : "BUY";
    const marginRaw = Number(x.margin ?? x.usedMargin ?? 0);
    const slRaw = Number(x.stopLoss ?? x.sl ?? 0);
    const tpRaw = Number(x.takeProfit ?? x.tp ?? 0);
    return {
      id: String(x.id || x.positionId || ""),
      symbol: String(x.symbol || ""),
      direction,
      lots: Number(x.volume || x.lots || 0),
      price: Number(x.openPrice || x.price || 0),
      profit: Number(x.profit || 0) + Number(x.swap || 0) + Number(x.commission || 0),
      margin: Number.isFinite(marginRaw) && marginRaw > 0 ? marginRaw : undefined,
      magic: x.magic != null ? Number(x.magic) : undefined,
      stopLoss: Number.isFinite(slRaw) && slRaw > 0 ? slRaw : undefined,
      takeProfit: Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : undefined,
    };
  });
}

/** UI-only snapshot cache. Trading/engine must use fetchSnapshot (always fresh). */
const DEFAULT_UI_SNAP_TTL_MS = 2500;
const snapCache = new Map<
  string,
  { at: number; value?: MetaSnap | MetaErr; inflight?: Promise<MetaSnap | MetaErr> }
>();
/** Last successful account-information fields — reused so hot ticks can fetch positions only. */
const accountInfoCache = new Map<
  string,
  {
    at: number;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    leverage: number;
    currency: string;
    name: string;
    server: string;
    login: string;
  }
>();
/** Global pause after 429 — stop REST burn until retry time. */
let metaApiRateLimitUntil = 0;
/** Separate pause when /trade 6h CPU credits are exhausted (retries only worsen it). */
let metaApiTradeCreditUntil = 0;

export function metaApiRateLimited(): boolean {
  return Date.now() < metaApiRateLimitUntil;
}

export function metaApiTradeCreditBlocked(): boolean {
  return Date.now() < metaApiTradeCreditUntil;
}

export function noteMetaApiRateLimit(retryAfterMs = 60_000) {
  // Cap pause so trading/stream recovery is not blocked for many minutes.
  const until = Date.now() + Math.max(10_000, Math.min(retryAfterMs, 90_000));
  if (until > metaApiRateLimitUntil) metaApiRateLimitUntil = until;
}

function isTradeCreditExhausted(data: unknown): boolean {
  const raw =
    typeof data === "string"
      ? data
      : data && typeof data === "object"
        ? JSON.stringify(data)
        : "";
  return /4320000 cpu credits|trade API allows|exceededPeriod["']?\s*:\s*["']?6h/i.test(
    raw,
  );
}

function noteTradeCreditExhausted() {
  const pauseMs = Math.max(
    60_000,
    Math.min(Number(process.env.METAAPI_TRADE_CREDIT_PAUSE_MS || 900_000), 1_800_000),
  );
  const until = Date.now() + pauseMs;
  if (until > metaApiTradeCreditUntil) metaApiTradeCreditUntil = until;
  noteMetaApiRateLimit(90_000);
  console.warn(
    `[metaapi] trade CPU credits exhausted — pause orders ${Math.round(pauseMs / 1000)}s`,
  );
}

function accountInfoTtlMs() {
  return Math.max(15_000, Number(process.env.METAAPI_ACCOUNT_INFO_TTL_MS || 60_000));
}

function snapMinIntervalMs() {
  return Math.max(2_000, Number(process.env.METAAPI_SNAP_MIN_MS || 8_000));
}

function priceCacheTtlMs() {
  return Math.max(500, Number(process.env.METAAPI_PRICE_CACHE_MS || 3_000));
}

function uiSnapTtlMs() {
  const raw = process.env.LIVE_SNAPSHOT_CACHE_MS;
  if (raw == null || raw === "") return DEFAULT_UI_SNAP_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_UI_SNAP_TTL_MS;
  return n;
}

/** Drop cached UI snapshots after any trade so the next screen refresh is fresh. */
export function invalidateSnapshotCache(metaApiAccountId?: string) {
  if (!metaApiAccountId) {
    snapCache.clear();
    return;
  }
  snapCache.delete(String(metaApiAccountId));
  // Keep accountInfoCache — balance can lag one tick after trade; positions refetch is enough
}

async function fetchSnapshotUncached(metaApiAccountId: string): Promise<MetaSnap | MetaErr> {
  const id = String(metaApiAccountId);
  if (metaApiRateLimited()) {
    const hit = snapCache.get(id)?.value;
    if (hit?.ok) return hit;
    return {
      ok: false,
      code: "RATE_LIMIT",
      message:
        "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
    };
  }

  const region = await resolveAccountRegion(id).catch(() => null);
  // Prefer live region only — do not fan-out to other regions (credits)
  const preferred = clientApiBases(region).slice(0, 1);
  const bases =
    preferred.length > 0 ? preferred : [clientBase(region || REGION)];

  const infoCached = accountInfoCache.get(id);
  const reuseInfo =
    !!infoCached && Date.now() - infoCached.at < accountInfoTtlMs();

  let info: unknown = null;
  let positionsRaw: unknown[] = [];
  let positionsErr: string | null = null;
  let lastStatus = 0;
  let lastBody: unknown = null;

  for (const base of bases) {
    if (reuseInfo) {
      const posRes = await api(
        base,
        "GET",
        `/users/current/accounts/${id}/positions`,
      );
      lastStatus = posRes.status;
      lastBody = posRes.data;
      if (posRes.status === 429) {
        noteMetaApiRateLimit(120_000);
        return {
          ok: false,
          code: "RATE_LIMIT",
          message:
            "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
        };
      }
      if (posRes.status < 400 && Array.isArray(posRes.data)) {
        info = {
          balance: infoCached!.balance,
          equity: infoCached!.equity,
          margin: infoCached!.margin,
          freeMargin: infoCached!.freeMargin,
          leverage: infoCached!.leverage,
          currency: infoCached!.currency,
          name: infoCached!.name,
          server: infoCached!.server,
          login: infoCached!.login,
        };
        positionsRaw = posRes.data;
        positionsErr = null;
        break;
      }
      // positions fail → fall through to full snap once
    }

    const [infoRes, posRes] = await Promise.all([
      api(base, "GET", `/users/current/accounts/${id}/account-information`),
      api(base, "GET", `/users/current/accounts/${id}/positions`),
    ]);
    lastStatus = infoRes.status;
    lastBody = infoRes.data;
    if (infoRes.status === 429 || posRes.status === 429) {
      noteMetaApiRateLimit(120_000);
      return {
        ok: false,
        code: "RATE_LIMIT",
        message:
          "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
      };
    }
    if (infoRes.status < 400) {
      info = infoRes.data;
      if (posRes.status >= 400 || !Array.isArray(posRes.data)) {
        const msg =
          (posRes.data as { message?: string } | null)?.message ||
          `포지션 조회 실패 (${posRes.status})`;
        positionsErr = toKoreanError(msg, "열린 포지션을 가져오지 못했습니다.");
        positionsRaw = [];
      } else {
        positionsRaw = posRes.data;
        positionsErr = null;
      }
      break;
    }
  }

  if (!info) {
    if (lastStatus === 429) {
      noteMetaApiRateLimit(120_000);
      return {
        ok: false,
        code: "RATE_LIMIT",
        message:
          "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
      };
    }
    if (lastStatus === 404 || lastStatus === 504 || lastStatus === 502) {
      return {
        ok: false,
        code: "NOT_CONNECTED",
        message:
          "MT5 클라우드가 브로커에 연결되지 않았습니다. 마이페이지에서 계좌를 다시 연결한 뒤 전체 시작을 눌러주세요.",
      };
    }
    return {
      ok: false,
      code: "UNKNOWN",
      message: toKoreanError(
        lastBody,
        "계좌 정보를 가져오지 못했습니다. 클라우드가 켜져 있는지 확인하세요.",
      ),
    };
  }

  if (positionsErr) {
    positionsRaw = [];
  }

  const i = info as Record<string, unknown>;
  const snap: MetaSnap = {
    ok: true,
    metaApiAccountId: id,
    balance: Number(i.balance || 0),
    equity: Number(i.equity || 0),
    margin: Number(i.margin || 0),
    freeMargin: Number(i.freeMargin || 0),
    leverage: Number(i.leverage || 0),
    currency: String(i.currency || "USD"),
    name: String(i.name || ""),
    server: String(i.server || ""),
    login: String(i.login || ""),
    positions: mapPositions(positionsRaw),
  };
  if (!reuseInfo) {
    accountInfoCache.set(id, {
      at: Date.now(),
      balance: snap.balance,
      equity: snap.equity,
      margin: snap.margin,
      freeMargin: snap.freeMargin,
      leverage: snap.leverage,
      currency: snap.currency,
      name: snap.name,
      server: snap.server,
      login: snap.login,
    });
  }
  return snap;
}

/**
 * Trading snapshot.
 * Prefer MetaAPI streaming terminalState (0 REST credits) when connected.
 * REST applies a min interval floor to avoid MetaAPI 429.
 * On rate-limit: attach/wait for stream — never block ENTRY/DCA solely because REST is paused.
 */
export async function fetchSnapshot(
  metaApiAccountId: string,
  opts?: { allowStaleMs?: number },
): Promise<MetaSnap | MetaErr> {
  const id = String(metaApiAccountId);
  const floor = snapMinIntervalMs();
  const want = Math.max(0, opts?.allowStaleMs ?? 0);
  const staleMs = Math.max(floor, want || floor);

  const tryStream = async (waitMs: number): Promise<MetaSnap | null> => {
    try {
      const { ensureStreamConnected, readStreamSnapshot } = await import(
        "./metaapi-stream"
      );
      const ready = await ensureStreamConnected(id);
      if (!ready) {
        const hit0 = readStreamSnapshot(id);
        return hit0?.ok ? hit0 : null;
      }
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const s = readStreamSnapshot(id);
        if (s?.ok) {
          snapCache.set(id, { at: Date.now(), value: s });
          return s;
        }
        if (Date.now() >= deadline) break;
        await sleep(250);
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  // Streaming first — no CPU credits (client rateLimiting docs).
  {
    const streamSnap = await tryStream(0);
    if (streamSnap) return streamSnap;
  }

  const hit = snapCache.get(id);
  if (hit?.value?.ok && Date.now() - hit.at < staleMs) return hit.value;
  if (hit?.inflight) return hit.inflight;

  if (metaApiRateLimited()) {
    if (hit?.value?.ok) return hit.value;
    // REST paused — recover via streaming so trading continues.
    const streamSnap = await tryStream(8_000);
    if (streamSnap) return streamSnap;
    if (hit?.value?.ok) return hit.value;
    return {
      ok: false,
      code: "RATE_LIMIT",
      message:
        "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
    };
  }

  const prevOk = hit?.value?.ok ? hit.value : undefined;
  const prevAt = hit?.value?.ok ? hit.at : Date.now();
  const inflight = fetchSnapshotUncached(id)
    .then(async (value) => {
      if (value.ok) {
        snapCache.set(id, { at: Date.now(), value });
        return value;
      }
      if (value.code === "RATE_LIMIT") {
        const streamSnap = await tryStream(8_000);
        if (streamSnap) return streamSnap;
        if (prevOk) {
          snapCache.set(id, { at: prevAt, value: prevOk });
          return prevOk;
        }
        snapCache.delete(id);
        return value;
      }
      snapCache.delete(id);
      return value;
    })
    .catch((err) => {
      if (prevOk) snapCache.set(id, { at: prevAt, value: prevOk });
      else snapCache.delete(id);
      throw err;
    });
  snapCache.set(id, { at: prevAt, value: prevOk, inflight });
  return inflight;
}

/**
 * UI live polls only. Short TTL + inflight coalesce to cut MetaAPI load.
 * Disabled when LIVE_SNAPSHOT_CACHE_MS=0. Errors are never cached.
 */
export async function fetchSnapshotCached(metaApiAccountId: string): Promise<MetaSnap | MetaErr> {
  const id = String(metaApiAccountId);
  const ttl = uiSnapTtlMs();
  if (ttl <= 0) return fetchSnapshotUncached(id);

  const hit = snapCache.get(id);
  if (hit?.value?.ok && Date.now() - hit.at < ttl) return hit.value;
  if (hit?.inflight) return hit.inflight;

  if (metaApiRateLimited()) {
    if (hit?.value?.ok) return hit.value;
    return {
      ok: false,
      code: "RATE_LIMIT",
      message:
        "MetaAPI 요청 한도에 도달했습니다. 잠시 후 자동 재시도됩니다. (봇·브로커 TP/SL 유지)",
    };
  }

  const prevOk = hit?.value?.ok ? hit.value : undefined;
  const prevAt = hit?.value?.ok ? hit.at : Date.now();
  const inflight = fetchSnapshotUncached(id)
    .then((value) => {
      if (value.ok) {
        snapCache.set(id, { at: Date.now(), value });
      } else if (value.code === "RATE_LIMIT" && prevOk) {
        snapCache.set(id, { at: prevAt, value: prevOk });
      } else {
        snapCache.delete(id);
      }
      return value;
    })
    .catch((err) => {
      if (prevOk) snapCache.set(id, { at: prevAt, value: prevOk });
      else snapCache.delete(id);
      throw err;
    });
  snapCache.set(id, { at: prevAt, value: prevOk, inflight });
  return inflight;
}

/** Zero Markets 등 브로커별 심볼명 후보 */
const SYMBOL_ALIASES: Record<string, string[]> = {
  EURUSD: ["EURUSD", "EURUSDm", "EURUSD.", "EURUSD#"],
  GBPUSD: ["GBPUSD", "GBPUSDm", "GBPUSD.", "GBPUSD#"],
  AUDUSD: ["AUDUSD", "AUDUSDm", "AUDUSD.", "AUDUSD#"],
  USDJPY: ["USDJPY", "USDJPYm", "USDJPY."],
  XAUUSD: ["XAUUSD", "GOLD", "XAUUSDm", "XAUUSD.", "XAUUSD#", "XAUUSD.a", "GOLD.a"],
  XAUEUR: ["XAUEUR", "GOLDEUR"],
  XAGUSD: ["XAGUSD", "SILVER", "XAGUSDm"],
  BTCUSD: ["BTCUSD", "BTCUSD.", "BTCUSDm"],
  WTI: ["WTI", "XTIUSD", "USOIL"],
  XTIUSD: ["XTIUSD", "WTI", "USOIL"],
  XBRUSD: ["XBRUSD", "UKOIL", "BRENT"],
};

const brokerSymbolCache = new Map<string, string>();
const brokerSymbolsListCache = new Map<string, { at: number; symbols: string[] }>();

function normalizeSymbolKey(s: string) {
  const u = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (u === "GOLD" || u.startsWith("XAU")) return "XAUUSD";
  if (u === "SILVER" || u.startsWith("XAG")) return "XAGUSD";
  if (u === "USOIL" || u === "WTI" || u === "XTIUSD") return "XTIUSD";
  if (u === "UKOIL" || u === "BRENT" || u === "XBRUSD") return "XBRUSD";
  return u;
}

/** 논리 심볼(XAUUSD) ↔ 브로커 심볼(GOLD 등) 동일 여부 */
export function symbolsMatch(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.toUpperCase() === b.toUpperCase()) return true;
  return normalizeSymbolKey(a) === normalizeSymbolKey(b);
}

export async function listBrokerSymbols(metaApiAccountId: string): Promise<string[]> {
  const cached = brokerSymbolsListCache.get(metaApiAccountId);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.symbols;

  // Prefer streaming specs (0 REST credits) — /symbols costs 500 CPU credits.
  try {
    const { readStreamSymbols, ensureStreamConnected } = await import("./metaapi-stream");
    await ensureStreamConnected(metaApiAccountId).catch(() => false);
    const fromStream = readStreamSymbols(metaApiAccountId);
    if (fromStream && fromStream.length > 0) {
      brokerSymbolsListCache.set(metaApiAccountId, {
        at: Date.now(),
        symbols: fromStream,
      });
      return fromStream;
    }
  } catch {
    /* fall through */
  }

  if (metaApiRateLimited()) return cached?.symbols || [];

  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const preferred = clientApiBases(region).slice(0, 1);
  const bases =
    preferred.length > 0 ? preferred : [clientBase(region || REGION)];
  for (const base of bases) {
    const res = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/symbols`,
    );
    if (res.status === 429) {
      noteMetaApiRateLimit(120_000);
      return cached?.symbols || [];
    }
    if (res.status < 400 && Array.isArray(res.data)) {
      const symbols = (res.data as unknown[]).map((s) => String(s));
      brokerSymbolsListCache.set(metaApiAccountId, { at: Date.now(), symbols });
      return symbols;
    }
  }
  return [];
}

/**
 * 앱 심볼명 → 브로커 실제 심볼명 해석 (XAUUSD → GOLD 등).
 * 가격·주문·청산에 반드시 이 이름을 쓴다.
 */
export async function resolveBrokerSymbol(metaApiAccountId: string, logical: string) {
  const key = `${metaApiAccountId}:${logical.toUpperCase()}`;
  const hit = brokerSymbolCache.get(key);
  if (hit) return hit;

  const want = logical.toUpperCase();
  const aliases = SYMBOL_ALIASES[want] || [logical];

  // Stream price proves the broker symbol without REST /symbols (500 credits).
  try {
    const { waitForStreamPrice } = await import("./metaapi-stream");
    const priced = await waitForStreamPrice(metaApiAccountId, aliases, 6_000);
    if (priced) {
      brokerSymbolCache.set(key, priced.symbol);
      return priced.symbol;
    }
  } catch {
    /* fall through */
  }

  const available = await listBrokerSymbols(metaApiAccountId);

  if (available.length > 0) {
    for (const alias of aliases) {
      const found = available.find((s) => s.toUpperCase() === alias.toUpperCase());
      if (found) {
        brokerSymbolCache.set(key, found);
        return found;
      }
    }
    const soft = available.find((s) => symbolsMatch(s, logical));
    if (soft) {
      brokerSymbolCache.set(key, soft);
      return soft;
    }
  }

  for (const alias of aliases) {
    const price = await getSymbolPriceRaw(metaApiAccountId, alias);
    if (price && price.bid > 0 && price.ask > 0) {
      brokerSymbolCache.set(key, alias);
      return alias;
    }
  }

  brokerSymbolCache.set(key, logical);
  return logical;
}

const priceCache = new Map<string, { at: number; bid: number; ask: number }>();

async function getSymbolPriceRaw(metaApiAccountId: string, symbol: string) {
  try {
    const { waitForStreamPrice, readStreamPrice } = await import("./metaapi-stream");
    const quick = readStreamPrice(metaApiAccountId, symbol);
    if (quick) return quick;
    const waited = await waitForStreamPrice(metaApiAccountId, [symbol], 5_000);
    if (waited) return { bid: waited.bid, ask: waited.ask };
  } catch {
    /* ignore */
  }
  if (metaApiRateLimited()) {
    const hit = priceCache.get(`${metaApiAccountId}|${symbol}`);
    if (hit) return { bid: hit.bid, ask: hit.ask };
    return null;
  }
  const cacheKey = `${metaApiAccountId}|${symbol}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < priceCacheTtlMs()) {
    return { bid: cached.bid, ask: cached.ask };
  }

  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const preferred = clientApiBases(region).slice(0, 1);
  const bases =
    preferred.length > 0 ? preferred : [clientBase(region || REGION)];
  for (const base of bases) {
    const res = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/symbols/${encodeURIComponent(symbol)}/current-price?keepSubscription=true`,
    );
    if (res.status === 429) {
      noteMetaApiRateLimit(120_000);
      return cached ? { bid: cached.bid, ask: cached.ask } : null;
    }
    if (res.status < 400 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      const bid = Number(d.bid ?? d.Bid ?? 0);
      const ask = Number(d.ask ?? d.Ask ?? 0);
      if (bid > 0 && ask > 0) {
        priceCache.set(cacheKey, { at: Date.now(), bid, ask });
        return { bid, ask };
      }
    }
  }
  return null;
}

export async function getSymbolPrice(metaApiAccountId: string, symbol: string) {
  const want = symbol.toUpperCase();
  const aliases = SYMBOL_ALIASES[want] || [symbol];
  // Fast path: stream quotes first (ENTRY/DCA blocker when REST is 429).
  try {
    const { waitForStreamPrice } = await import("./metaapi-stream");
    const priced = await waitForStreamPrice(metaApiAccountId, aliases, 8_000);
    if (priced) {
      const key = `${metaApiAccountId}:${want}`;
      brokerSymbolCache.set(key, priced.symbol);
      return {
        bid: priced.bid,
        ask: priced.ask,
        brokerSymbol: priced.symbol,
      };
    }
  } catch {
    /* fall through */
  }

  const brokerSym = await resolveBrokerSymbol(metaApiAccountId, symbol);
  const price = await getSymbolPriceRaw(metaApiAccountId, brokerSym);
  if (!price) return null;
  return { bid: price.bid, ask: price.ask, brokerSymbol: brokerSym };
}

export async function placeMarketOrder(input: {
  metaApiAccountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  comment?: string;
  /** 진입과 동시에 브로커 지정가 심기 (나체 창 최소화) */
  stopLoss?: number | null;
  takeProfit?: number | null;
}) {
  const t0 = Date.now();
  const brokerSym = await resolveBrokerSymbol(input.metaApiAccountId, input.symbol);

  // Prefer streaming trade (avoids exhausted REST /trade CPU quota).
  try {
    const { streamPlaceMarketOrder } = await import("./metaapi-stream");
    const streamed = await streamPlaceMarketOrder({
      metaApiAccountId: input.metaApiAccountId,
      symbol: brokerSym,
      direction: input.direction,
      lots: input.lots,
      comment: input.comment,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
    });
    if (streamed?.ok) {
      invalidateSnapshotCache(input.metaApiAccountId);
      return { ok: true as const, data: streamed.data, brokerSymbol: brokerSym, via: "stream" as const };
    }
    // Soft broker reject (e.g. TP/SL) — caller may retry naked; don't fall through if stream ran.
    if (streamed && !streamed.ok) {
      const soft =
        /Invalid stops|Invalid S\/L|Invalid T\/P|stops level|TRADE_RETCODE_INVALID_STOPS|TRADE_RETCODE_INVALID_PRICE/i.test(
          streamed.message || JSON.stringify(streamed.data || ""),
        );
      if (!soft) {
        // Stream connected but order failed for non-stops reason — still try REST only if not credit-blocked.
        // Stops rejects should return so caller can naked-retry via stream again.
      } else {
        invalidateSnapshotCache(input.metaApiAccountId);
        return {
          ok: false as const,
          message: streamed.message || "주문에 실패했습니다.",
          data: streamed.data,
          brokerSymbol: brokerSym,
          via: "stream" as const,
        };
      }
      // Non-soft stream fail: attempt REST fallback below (unless trade credits exhausted).
      if (metaApiTradeCreditBlocked()) {
        invalidateSnapshotCache(input.metaApiAccountId);
        return {
          ok: false as const,
          message: streamed.message || "주문에 실패했습니다.",
          data: streamed.data,
          brokerSymbol: brokerSym,
          via: "stream" as const,
        };
      }
    }
  } catch (e) {
    console.warn(
      "[metaapi] stream placeMarketOrder fallback",
      e instanceof Error ? e.message : e,
    );
  }

  if (metaApiTradeCreditBlocked()) {
    return {
      ok: false as const,
      message: "MetaAPI 주문 한도(6시간) 소진 — 잠시 후 재시도",
      brokerSymbol: brokerSym,
    };
  }

  const base = await tradeApiBase(input.metaApiAccountId);
  const actionType = input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const body: Record<string, unknown> = {
    actionType,
    symbol: brokerSym,
    volume: input.lots,
    comment: input.comment || "SuperAlpha",
  };
  if (input.stopLoss != null && Number.isFinite(input.stopLoss) && input.stopLoss > 0) {
    body.stopLoss = input.stopLoss;
  }
  if (input.takeProfit != null && Number.isFinite(input.takeProfit) && input.takeProfit > 0) {
    body.takeProfit = input.takeProfit;
  }

  // Soft 429: brief retry. Hard 6h trade-credit exhaustion: pause, no retry storm.
  let res = await api(
    base,
    "POST",
    `/users/current/accounts/${input.metaApiAccountId}/trade`,
    body,
  );
  if (res.status === 429 || isRateLimitError(res.data)) {
    if (isTradeCreditExhausted(res.data)) {
      noteTradeCreditExhausted();
    } else {
      for (
        let attempt = 0;
        attempt < 2 && (res.status === 429 || isRateLimitError(res.data));
        attempt++
      ) {
        if (isTradeCreditExhausted(res.data)) {
          noteTradeCreditExhausted();
          break;
        }
        noteMetaApiRateLimit(20_000);
        await sleep(1500 * (attempt + 1));
        res = await api(
          base,
          "POST",
          `/users/current/accounts/${input.metaApiAccountId}/trade`,
          body,
        );
      }
      if (isTradeCreditExhausted(res.data)) noteTradeCreditExhausted();
    }
  }

  invalidateSnapshotCache(input.metaApiAccountId);
  const ms = Date.now() - t0;
  if (ms >= 800) {
    console.warn(
      `[metaapi] slow placeMarketOrder ${ms}ms regionHost=${base.includes("new-york") ? "ny" : base.includes("london") ? "lon" : "other"} ${brokerSym}`,
    );
  }
  if (res.status >= 400) {
    // 동봉 TP/SL 거절 시 나체로라도 진입 재시도하지 않음 — 호출측이 보호 없이 재시도 판단
    return {
      ok: false as const,
      message: toKoreanError(res.data, "주문에 실패했습니다."),
      data: res.data,
      brokerSymbol: brokerSym,
      via: "rest" as const,
    };
  }
  return { ok: true as const, data: res.data, brokerSymbol: brokerSym, via: "rest" as const };
}

/** 심볼 거래 스펙 (stopsLevel / digits) — modify 거절 방지용 캐시 */
const symbolSpecCache = new Map<
  string,
  { at: number; stopsLevel: number; digits: number; point: number }
>();

export async function getSymbolTradeSpec(metaApiAccountId: string, symbol: string) {
  const brokerSym = await resolveBrokerSymbol(metaApiAccountId, symbol);
  const key = `${metaApiAccountId}|${brokerSym}`;
  const hit = symbolSpecCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return { ...hit, brokerSymbol: brokerSym };

  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const bases = clientApiBases(region);
  for (const base of bases) {
    const res = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/symbols/${encodeURIComponent(brokerSym)}`,
    );
    if (res.status < 400 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      const digits = Number(d.digits ?? d.symbolDigits ?? 5);
      const point = Number(d.point ?? d.tradeTickSize ?? (digits >= 0 ? 10 ** -digits : 0.00001));
      const stopsLevel = Number(
        d.stopsLevel ?? d.tradeStopsLevel ?? d.stopLevel ?? 0,
      );
      const spec = {
        at: Date.now(),
        stopsLevel: Number.isFinite(stopsLevel) && stopsLevel > 0 ? stopsLevel : 0,
        digits: Number.isFinite(digits) ? digits : 5,
        point: Number.isFinite(point) && point > 0 ? point : 0.00001,
      };
      symbolSpecCache.set(key, spec);
      return { ...spec, brokerSymbol: brokerSym };
    }
  }
  const fallback = { at: Date.now(), stopsLevel: 0, digits: 5, point: 0.00001 };
  symbolSpecCache.set(key, fallback);
  return { ...fallback, brokerSymbol: brokerSym };
}

export async function closePosition(metaApiAccountId: string, positionId: string) {
  try {
    const { streamClosePosition } = await import("./metaapi-stream");
    const streamed = await streamClosePosition(metaApiAccountId, positionId);
    if (streamed?.ok) {
      invalidateSnapshotCache(metaApiAccountId);
      return { ok: true as const, via: "stream" as const };
    }
    if (streamed && !streamed.ok && metaApiTradeCreditBlocked()) {
      return { ok: false as const, message: streamed.message };
    }
  } catch (e) {
    console.warn(
      "[metaapi] stream closePosition fallback",
      e instanceof Error ? e.message : e,
    );
  }

  if (metaApiTradeCreditBlocked()) {
    return {
      ok: false as const,
      message: "MetaAPI 주문 한도(6시간) 소진 — 잠시 후 재시도",
    };
  }

  const base = await tradeApiBase(metaApiAccountId);
  const res = await api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
    actionType: "POSITION_CLOSE_ID",
    positionId,
  });
  invalidateSnapshotCache(metaApiAccountId);
  if (res.status >= 400) {
    if (isTradeCreditExhausted(res.data)) noteTradeCreditExhausted();
    return { ok: false as const, message: toKoreanError(res.data, "청산에 실패했습니다.") };
  }
  return { ok: true as const, via: "rest" as const };
}

/**
 * 브로커 포지션에 지정 손절/익절가 설정 (MT5 POSITION_MODIFY).
 * 엔진 폴링과 무관하게 서버에서 TP/SL 체결되게 하는 1차 방어.
 */
export async function modifyPositionProtection(input: {
  metaApiAccountId: string;
  positionId: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
}) {
  if (
    (input.stopLoss == null || !(input.stopLoss > 0)) &&
    (input.takeProfit == null || !(input.takeProfit > 0))
  ) {
    return { ok: false as const, message: "stopLoss/takeProfit 값이 없습니다." };
  }

  try {
    const { streamModifyPosition } = await import("./metaapi-stream");
    const streamed = await streamModifyPosition(input);
    if (streamed?.ok) {
      return { ok: true as const, data: streamed.data, via: "stream" as const };
    }
    if (streamed && !streamed.ok && metaApiTradeCreditBlocked()) {
      return {
        ok: false as const,
        message: streamed.message,
        data: streamed.data,
      };
    }
  } catch (e) {
    console.warn(
      "[metaapi] stream modifyPosition fallback",
      e instanceof Error ? e.message : e,
    );
  }

  if (metaApiTradeCreditBlocked()) {
    return {
      ok: false as const,
      message: "MetaAPI 주문 한도(6시간) 소진 — 잠시 후 재시도",
    };
  }

  const base = await tradeApiBase(input.metaApiAccountId);
  const body: Record<string, unknown> = {
    actionType: "POSITION_MODIFY",
    positionId: input.positionId,
  };
  if (input.stopLoss != null && Number.isFinite(input.stopLoss) && input.stopLoss > 0) {
    body.stopLoss = input.stopLoss;
  }
  if (input.takeProfit != null && Number.isFinite(input.takeProfit) && input.takeProfit > 0) {
    body.takeProfit = input.takeProfit;
  }
  const res = await api(base, "POST", `/users/current/accounts/${input.metaApiAccountId}/trade`, body);
  if (res.status === 429 || isRateLimitError(res.data)) {
    if (isTradeCreditExhausted(res.data)) {
      noteTradeCreditExhausted();
      return {
        ok: false as const,
        message: toKoreanError(res.data, "포지션 TP/SL 수정에 실패했습니다."),
        data: res.data,
      };
    }
    noteMetaApiRateLimit(20_000);
    await sleep(2000);
    const retry = await api(
      base,
      "POST",
      `/users/current/accounts/${input.metaApiAccountId}/trade`,
      body,
    );
    if (retry.status < 400) return { ok: true as const, data: retry.data, via: "rest" as const };
    if (isTradeCreditExhausted(retry.data)) noteTradeCreditExhausted();
    return {
      ok: false as const,
      message: toKoreanError(retry.data, "포지션 TP/SL 수정에 실패했습니다."),
      data: retry.data,
    };
  }
  if (res.status >= 400) {
    return {
      ok: false as const,
      message: toKoreanError(res.data, "포지션 TP/SL 수정에 실패했습니다."),
      data: res.data,
    };
  }
  return { ok: true as const, data: res.data, via: "rest" as const };
}

/**
 * 심볼 전체 청산. MetaAPI POSITIONS_CLOSE_SYMBOL 우선(대량 포지션 안전),
 * 남은 건 POSITION_CLOSE_ID 폴백. 잔여 포지션이 있으면 ok:false.
 */
export async function closePositionsBySymbol(metaApiAccountId: string, symbol: string) {
  const snap = await fetchSnapshot(metaApiAccountId);
  if (!snap.ok) return snap;
  const targets = snap.positions.filter((x) => symbolsMatch(x.symbol, symbol));
  if (targets.length === 0) {
    return { ok: true as const, closed: 0, remaining: 0 };
  }

  const brokerSym = await resolveBrokerSymbol(metaApiAccountId, symbol);
  const base = await tradeApiBase(metaApiAccountId);
  // 한 심볼 일괄 청산 — 수백 포지션을 하나씩 닫으면 틱 타임아웃/부분청산 위험
  const bulk = await api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
    actionType: "POSITIONS_CLOSE_SYMBOL",
    symbol: brokerSym,
  });
  invalidateSnapshotCache(metaApiAccountId);
  // 브로커 심볼명이 포지션과 다를 수 있음(XAUUSD vs GOLD) — 포지션에 찍힌 이름으로도 시도
  const posSymbols = [...new Set(targets.map((t) => t.symbol).filter(Boolean))];
  for (const ps of posSymbols) {
    if (ps === brokerSym) continue;
    await api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
      actionType: "POSITIONS_CLOSE_SYMBOL",
      symbol: ps,
    });
  }
  if (bulk.status >= 400 && posSymbols.length === 0) {
    // fall through to per-id
  }

  let after = await fetchSnapshot(metaApiAccountId);
  let remaining = after.ok
    ? after.positions.filter((x) => symbolsMatch(x.symbol, symbol))
    : targets;

  // 잔여분 개별 청산
  for (const p of remaining) {
    if (p.id) await closePosition(metaApiAccountId, p.id);
  }

  after = await fetchSnapshot(metaApiAccountId);
  if (!after.ok) {
    return {
      ok: false as const,
      message: after.message || "청산 후 잔여 확인 실패",
      closed: targets.length,
      remaining: -1,
    };
  }
  remaining = after.positions.filter((x) => symbolsMatch(x.symbol, symbol));
  if (remaining.length > 0) {
    return {
      ok: false as const,
      message: `${symbol} 청산 후 ${remaining.length}건 잔여`,
      closed: targets.length - remaining.length,
      remaining: remaining.length,
    };
  }
  return { ok: true as const, closed: targets.length, remaining: 0 };
}

/**
 * 방향별 심볼 청산 — 양방향(dualDirection) 운용용. POSITIONS_CLOSE_SYMBOL은 방향
 * 구분이 없어 반대편 바스켓까지 닫으므로, 해당 방향 포지션만 ID로 개별 청산한다.
 */
export async function closePositionsBySymbolDirection(
  metaApiAccountId: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  const MAX_ROUNDS = 3;
  let closedTotal = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const snap = await fetchSnapshot(metaApiAccountId);
    if (!snap.ok) return snap;
    const targets = snap.positions.filter(
      (x) => symbolsMatch(x.symbol, symbol) && x.direction === direction,
    );
    if (targets.length === 0) {
      return { ok: true as const, closed: closedTotal, remaining: 0 };
    }

    const ids = targets.map((t) => t.id).filter(Boolean);
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(ids.slice(i, i + BATCH).map((id) => closePosition(metaApiAccountId, id)));
    }
    closedTotal += targets.length;
    await sleep(350);

    const after = await fetchSnapshot(metaApiAccountId);
    if (!after.ok) {
      return {
        ok: false as const,
        message: after.message || "청산 후 잔여 확인 실패",
        closed: closedTotal,
        remaining: -1,
      };
    }
    const remaining = after.positions.filter(
      (x) => symbolsMatch(x.symbol, symbol) && x.direction === direction,
    );
    if (remaining.length === 0) {
      return { ok: true as const, closed: closedTotal, remaining: 0 };
    }
    if (round === MAX_ROUNDS - 1) {
      return {
        ok: false as const,
        message: `${symbol} ${direction} 청산 후 ${remaining.length}건 잔여`,
        closed: Math.max(0, closedTotal - remaining.length),
        remaining: remaining.length,
      };
    }
  }

  return { ok: true as const, closed: closedTotal, remaining: 0 };
}

/**
 * 계좌 전체 청산. 심볼별 POSITIONS_CLOSE_SYMBOL을 병렬 호출(MT5 Close All과 동일하게 일괄),
 * 잔여가 있으면 심볼 재시도 + POSITION_CLOSE_ID 병렬 폴백 1회.
 */
export async function closeAllPositions(metaApiAccountId: string) {
  const snap = await fetchSnapshot(metaApiAccountId);
  if (!snap.ok) return snap;

  const beforeCount = snap.positions.length;
  if (beforeCount === 0) {
    return { ok: true as const, closed: 0, remaining: 0, symbols: 0 };
  }

  const base = await tradeApiBase(metaApiAccountId);
  const closeBySymbols = async (symbols: string[]) => {
    await Promise.all(
      symbols.map((symbol) =>
        api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
          actionType: "POSITIONS_CLOSE_SYMBOL",
          symbol,
        }),
      ),
    );
  };

  const symbols = [...new Set(snap.positions.map((p) => p.symbol).filter(Boolean))];
  await closeBySymbols(symbols);
  await sleep(400);

  let after = await fetchSnapshot(metaApiAccountId);
  let remaining = after.ok ? after.positions : snap.positions;

  if (remaining.length > 0) {
    const retrySymbols = [...new Set(remaining.map((p) => p.symbol).filter(Boolean))];
    await closeBySymbols(retrySymbols);
    await Promise.all(
      remaining.filter((p) => p.id).map((p) => closePosition(metaApiAccountId, p.id)),
    );
    await sleep(300);
    after = await fetchSnapshot(metaApiAccountId);
    remaining = after.ok ? after.positions : remaining;
  }

  const closed = Math.max(0, beforeCount - remaining.length);
  if (remaining.length > 0) {
    return {
      ok: false as const,
      message: `전체 청산 후 ${remaining.length}건 잔여 (${closed}건 청산됨)`,
      closed,
      remaining: remaining.length,
      symbols: symbols.length,
    };
  }
  return { ok: true as const, closed, remaining: 0, symbols: symbols.length };
}

export async function verifyMt5Credentials(input: {
  login: string;
  password: string;
  server: string;
  reuseAccountId?: string | null;
}) {
  return provisionTradingAccount(input);
}

export async function syncMt5Account(metaApiAccountId: string) {
  return fetchSnapshot(metaApiAccountId);
}

export type MetaDeal = {
  id: string;
  type: string;
  entryType?: string;
  symbol: string;
  profit: number;
  swap: number;
  commission: number;
  time: string;
  volume: number;
  price?: number;
  reason?: string;
};

const TRADE_DEAL_TYPES = new Set(["DEAL_TYPE_BUY", "DEAL_TYPE_SELL"]);

/** MT5 총손익과 동일: profit + swap + commission (잔고입출금 제외) */
export function dealNetPnl(d: Pick<MetaDeal, "profit" | "swap" | "commission">) {
  return Number(d.profit || 0) + Number(d.swap || 0) + Number(d.commission || 0);
}

export function sumMt5TradePnl(deals: MetaDeal[]) {
  return deals
    .filter((d) => TRADE_DEAL_TYPES.has(d.type))
    .reduce((s, d) => s + dealNetPnl(d), 0);
}

function mapDeals(raw: unknown[]): MetaDeal[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const x = row as Record<string, unknown>;
    return {
      id: String(x.id || ""),
      type: String(x.type || ""),
      entryType: x.entryType != null ? String(x.entryType) : undefined,
      symbol: String(x.symbol || ""),
      profit: Number(x.profit || 0),
      swap: Number(x.swap || 0),
      commission: Number(x.commission || 0),
      time: String(x.time || ""),
      volume: Number(x.volume || 0),
      price: Number(x.price || x.openPrice || 0) || undefined,
      reason: x.reason != null ? String(x.reason) : undefined,
    };
  });
}

/**
 * MT5 거래 내역(딜) — 터미널 계정 기록과 동일 소스.
 * GET .../history-deals/time/:start/:end
 */
export async function fetchHistoryDeals(
  metaApiAccountId: string,
  start: Date,
  end: Date,
): Promise<{ ok: true; deals: MetaDeal[] } | MetaErr> {
  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const bases = clientApiBases(region);
  const startIso = encodeURIComponent(start.toISOString());
  const endIso = encodeURIComponent(end.toISOString());
  const pathBase = `/users/current/accounts/${metaApiAccountId}/history-deals/time/${startIso}/${endIso}`;

  let lastErr: MetaErr | null = null;
  for (const base of bases) {
    const all: MetaDeal[] = [];
    let offset = 0;
    const limit = 1000;
    let ok = false;
    for (;;) {
      const res = await api(base, "GET", `${pathBase}?offset=${offset}&limit=${limit}`);
      if (res.status >= 400 || !Array.isArray(res.data)) {
        lastErr = {
          ok: false,
          code: `HTTP_${res.status}`,
          message: toKoreanError(
            (res.data as { message?: string } | null)?.message,
            "MT5 거래내역을 가져오지 못했습니다.",
          ),
        };
        break;
      }
      ok = true;
      const chunk = mapDeals(res.data);
      all.push(...chunk);
      if (chunk.length < limit) break;
      offset += limit;
      if (offset > 20_000) break;
    }
    if (ok) return { ok: true, deals: all };
  }

  return (
    lastErr || {
      ok: false,
      code: "NETWORK",
      message: "MT5 거래내역을 가져오지 못했습니다.",
    }
  );
}
