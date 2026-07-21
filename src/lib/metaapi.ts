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

async function resolveAccountRegion(metaApiAccountId: string): Promise<string | null> {
  const id = String(metaApiAccountId);
  const cached = metaRegionCache.get(id);
  if (cached) return cached;
  const st = await getMetaAccountStatus(id);
  const region =
    st.raw && typeof st.raw === "object"
      ? String((st.raw as { region?: string }).region || "")
      : "";
  if (region) {
    metaRegionCache.set(id, region);
    return region;
  }
  return null;
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

      const retryable = res.status === 429 || res.status === 503 || res.status === 502;
      if (retryable && attempt < maxAttempts) {
        const ra = res.headers.get("retry-after");
        const parsed = ra ? Number(ra) * 1000 : NaN;
        const backoff = Number.isFinite(parsed)
          ? Math.min(parsed, 8_000)
          : Math.min(1000 * 2 ** (attempt - 1), 8_000);
        await sleep(backoff);
        continue;
      }
      return { status: res.status, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network";
      lastStatus = 0;
      lastData = { message: msg, details: "NETWORK" };
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

function metaAccountScore(a: {
  state: string;
  connectionStatus: string;
  type?: string;
}) {
  const conn = a.connectionStatus.toUpperCase();
  let s = 0;
  if (a.state === "DEPLOYED") s += 10;
  if (conn.includes("CONNECTED")) s += 20;
  if (conn.includes("FULL")) s += 5;
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
    const connectionStatus = String(d.connectionStatus || "");
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

    if (
      state === "DEPLOYED" &&
      (connectionStatus === "CONNECTED" ||
        connectionStatus === "CONNECTED_NEW_ACCOUNT" ||
        connectionStatus.toUpperCase().includes("CONNECTED"))
    ) {
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
    message: "서버 연결 시간이 초과되었습니다. 계좌·서버명을 확인한 뒤 다시 시도해주세요.",
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
  const waited = await waitUntilConnected(id, 28000);

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
  // Credentials OK; balances unknown until next live sync
  return softLinkSnap({ login: input.login, server: input.server }, id, input.name);
}

/** Deploy + wait until MetaAPI can read the broker account (for live sync). */
export async function ensureCloudLive(metaApiAccountId: string, waitMs = 45000) {
  const id = String(metaApiAccountId);
  await deployAccount(id);
  const waited = await waitUntilConnected(id, waitMs);
  if (!waited.ok) {
    // Still try snapshot — sometimes DEPLOYED works before connectionStatus updates
    const snap = await fetchSnapshot(id);
    if (snap.ok) return { ok: true as const, snap };
    return { ok: false as const, message: waited.message };
  }
  const snap = await fetchSnapshot(id);
  if (!snap.ok) return { ok: false as const, message: snap.message };
  return { ok: true as const, snap };
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
 * Default: cheap g1/regular only (stops duplicate g2 high burn).
 * Set METAAPI_PREFER_G2=1 to try expensive g2/high first.
 */
function provisionModes(): CloudMode[] {
  const g1: CloudMode = { type: "cloud-g1", reliability: "regular", label: "일반(g1)" };
  const g2: CloudMode = { type: "cloud-g2", reliability: "high", label: "고성능(g2)" };
  if (process.env.METAAPI_FORCE_G1 === "1") return [g1];
  if (process.env.METAAPI_PREFER_G2 === "1") return [g2, g1];
  return [g1];
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
  if (already?.id) return softLinkSnap(input, already.id, already.name);

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

  const created = await api(PROVISIONING, "POST", "/users/current/accounts", payload, {
    "transaction-id": newTransactionId(),
  });

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
    return {
      id: String(x.id || x.positionId || ""),
      symbol: String(x.symbol || ""),
      direction,
      lots: Number(x.volume || x.lots || 0),
      price: Number(x.openPrice || x.price || 0),
      profit: Number(x.profit || 0) + Number(x.swap || 0) + Number(x.commission || 0),
      margin: Number.isFinite(marginRaw) && marginRaw > 0 ? marginRaw : undefined,
      magic: x.magic != null ? Number(x.magic) : undefined,
    };
  });
}

export async function fetchSnapshot(metaApiAccountId: string): Promise<MetaSnap | MetaErr> {
  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const bases = clientApiBases(region);
  let info: unknown = null;
  let positionsRaw: unknown[] = [];
  let positionsErr: string | null = null;

  for (const base of bases) {
    const infoRes = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/account-information`,
    );
    if (infoRes.status < 400) {
      info = infoRes.data;
      const posRes = await api(base, "GET", `/users/current/accounts/${metaApiAccountId}/positions`);
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
    return {
      ok: false,
      code: "UNKNOWN",
      message: "계좌 정보를 가져오지 못했습니다. 클라우드가 켜져 있는지 확인하세요.",
    };
  }

  // Positions failure should not wipe balance/equity display
  if (positionsErr) {
    positionsRaw = [];
  }

  const i = info as Record<string, unknown>;
  return {
    ok: true,
    metaApiAccountId,
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
}

/** Zero Markets 등 브로커별 심볼명 후보 */
const SYMBOL_ALIASES: Record<string, string[]> = {
  EURUSD: ["EURUSD", "EURUSDm", "EURUSD.", "EURUSD#"],
  GBPUSD: ["GBPUSD", "GBPUSDm", "GBPUSD."],
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

  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const bases = clientApiBases(region);
  for (const base of bases) {
    const res = await api(base, "GET", `/users/current/accounts/${metaApiAccountId}/symbols`);
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

async function getSymbolPriceRaw(metaApiAccountId: string, symbol: string) {
  const region = await resolveAccountRegion(metaApiAccountId).catch(() => null);
  const bases = clientApiBases(region);
  for (const base of bases) {
    const res = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/symbols/${encodeURIComponent(symbol)}/current-price?keepSubscription=true`,
    );
    if (res.status < 400 && res.data && typeof res.data === "object") {
      const d = res.data as { bid?: number; ask?: number };
      const bid = Number(d.bid || 0);
      const ask = Number(d.ask || 0);
      if (bid > 0 && ask > 0) return { bid, ask, symbol };
    }
  }
  return null;
}

export async function getSymbolPrice(metaApiAccountId: string, symbol: string) {
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
}) {
  const base = clientBase();
  const brokerSym = await resolveBrokerSymbol(input.metaApiAccountId, input.symbol);
  const actionType = input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const res = await api(base, "POST", `/users/current/accounts/${input.metaApiAccountId}/trade`, {
    actionType,
    symbol: brokerSym,
    volume: input.lots,
    comment: input.comment || "SuperAlpha",
  });
  if (res.status >= 400) {
    return {
      ok: false as const,
      message: toKoreanError(res.data, "주문에 실패했습니다."),
      data: res.data,
      brokerSymbol: brokerSym,
    };
  }
  return { ok: true as const, data: res.data, brokerSymbol: brokerSym };
}

export async function closePosition(metaApiAccountId: string, positionId: string) {
  const base = clientBase();
  const res = await api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
    actionType: "POSITION_CLOSE_ID",
    positionId,
  });
  if (res.status >= 400) {
    return { ok: false as const, message: toKoreanError(res.data, "청산에 실패했습니다.") };
  }
  return { ok: true as const };
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
  const base = clientBase();
  // 한 심볼 일괄 청산 — 수백 포지션을 하나씩 닫으면 틱 타임아웃/부분청산 위험
  const bulk = await api(base, "POST", `/users/current/accounts/${metaApiAccountId}/trade`, {
    actionType: "POSITIONS_CLOSE_SYMBOL",
    symbol: brokerSym,
  });
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
  const snap = await fetchSnapshot(metaApiAccountId);
  if (!snap.ok) return snap;
  const targets = snap.positions.filter(
    (x) => symbolsMatch(x.symbol, symbol) && x.direction === direction,
  );
  if (targets.length === 0) return { ok: true as const, closed: 0, remaining: 0 };

  // 소량씩 병렬 청산 (틱 타임아웃 방지)
  const ids = targets.map((t) => t.id).filter(Boolean);
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map((id) => closePosition(metaApiAccountId, id)));
  }

  const after = await fetchSnapshot(metaApiAccountId);
  if (!after.ok) {
    return { ok: false as const, message: after.message || "청산 후 잔여 확인 실패", closed: targets.length, remaining: -1 };
  }
  const remaining = after.positions.filter(
    (x) => symbolsMatch(x.symbol, symbol) && x.direction === direction,
  );
  if (remaining.length > 0) {
    return {
      ok: false as const,
      message: `${symbol} ${direction} 청산 후 ${remaining.length}건 잔여`,
      closed: targets.length - remaining.length,
      remaining: remaining.length,
    };
  }
  return { ok: true as const, closed: targets.length, remaining: 0 };
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

  const base = clientBase();
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
