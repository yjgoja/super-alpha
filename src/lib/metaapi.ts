/**
 * MetaAPI cloud — provision, deploy/undeploy, sync, trade.
 * Defaults to cloud-g1 + regular (works without high-reliability top-up).
 * Falls back automatically if a preferred mode fails.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { isTopUpOrHighReliabilityError, toKoreanError } from "./ko-errors";

const PROVISIONING =
  process.env.METAAPI_PROVISIONING_URL ||
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

const REGION = process.env.METAAPI_REGION || "new-york";

function clientBase(region = REGION) {
  return (
    process.env.METAAPI_CLIENT_URL ||
    `https://mt-client-api-v1.${region}.agiliumtrade.ai`
  );
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
    magic?: number;
  }>;
};

export type MetaErr = {
  ok: false;
  code: string;
  message: string;
};

async function api(
  base: string,
  method: string,
  pathName: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const t = token();
  if (!t) {
    throw Object.assign(new Error("MetaAPI 토큰이 없습니다."), { code: "NO_TOKEN" });
  }

  const res = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      "auth-token": t,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text, message: text };
  }
  return { status: res.status, data };
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
  Array<{ id: string; login: string; name: string; state: string; connectionStatus: string }>
> {
  const res = await api(PROVISIONING, "GET", "/users/current/accounts");
  if (res.status >= 400 || !Array.isArray(res.data)) return [];
  return (res.data as unknown[]).map((raw) => {
    const x = raw as Record<string, unknown>;
    return {
      id: pickMetaAccountId(raw),
      login: String(x.login || ""),
      name: String(x.name || ""),
      state: String(x.state || ""),
      connectionStatus: String(x.connectionStatus || ""),
    };
  });
}

/** Find already-created MetaAPI account for this MT5 login. */
export async function findMetaAccountByLogin(login: string) {
  const list = await listMetaAccounts();
  const want = login.trim();
  const exact =
    list.find((a) => a.login === want) ||
    list.find((a) => a.name === `SA-${want}`) ||
    list.find((a) => a.name.includes(want));
  if (exact) return exact;
  // Never reuse an unrelated MetaAPI account (multi-user safety).
  return null;
}

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
    await deployAccount(existing.id).catch(() => null);
    return { ok: true, metaApiAccountId: existing.id };
  }

  const profileId = await ensureProvisioningProfile();
  const modes = provisionModes();
  let lastErr: MetaErr | null = null;

  for (const mode of modes) {
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

    if (created.status >= 400) {
      const code = errCode(created.data);
      // Duplicate / already exists → resolve via list
      const again = await findMetaAccountByLogin(input.login);
      if (again?.id) {
        await deployAccount(again.id).catch(() => null);
        return { ok: true, metaApiAccountId: again.id };
      }
      lastErr = {
        ok: false,
        code: code || "CREATE_FAILED",
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
      continue;
    }

    const accountId = pickMetaAccountId(created.data);
    if (!accountId) {
      lastErr = { ok: false, code: "UNKNOWN", message: "클라우드 계좌 ID를 받지 못했습니다." };
      continue;
    }

    await deployAccount(accountId);
    return { ok: true, metaApiAccountId: accountId };
  }

  // Last resort: list by login
  const fallback = await findMetaAccountByLogin(input.login);
  if (fallback?.id) {
    await deployAccount(fallback.id).catch(() => null);
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
    const state = (res.data as { state?: string })?.state;
    const connectionStatus = (res.data as { connectionStatus?: string })?.connectionStatus;
    const code = errCode(res.data);

    if (
      state === "DEPLOYED" &&
      (connectionStatus === "CONNECTED" ||
        connectionStatus === "CONNECTED_NEW_ACCOUNT" ||
        String(connectionStatus || "")
          .toUpperCase()
          .includes("CONNECTED"))
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  return {
    ok: false as const,
    code: "TIMEOUT",
    message: "서버 연결 시간이 초과되었습니다. 계좌·서버명을 확인한 뒤 다시 승인해주세요.",
  };
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

/** Prefer modes that work without high-reliability wallet top-up. */
function provisionModes(): CloudMode[] {
  const g1: CloudMode = { type: "cloud-g1", reliability: "regular", label: "일반(g1)" };
  const g2: CloudMode = { type: "cloud-g2", reliability: "high", label: "고성능(g2)" };
  // Try g2 first (after wallet top-up); fall back to g1 if high-reliability blocked
  if (process.env.METAAPI_FORCE_G1 === "1") return [g1];
  return [g2, g1];
}

async function createAndConnect(input: {
  login: string;
  password: string;
  server: string;
  profileId?: string;
  mode: CloudMode;
}): Promise<MetaSnap | MetaErr> {
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

  if (created.status >= 400) {
    const code = errCode(created.data);
    if (isTopUpOrHighReliabilityError(created.data)) {
      return {
        ok: false,
        code: "TOP_UP",
        message: toKoreanError(created.data),
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
    return { ok: false, code: "UNKNOWN", message: "클라우드 계좌 ID를 받지 못했습니다." };
  }

  const dep = await deployAccount(accountId);
  if (dep.status >= 400 && isTopUpOrHighReliabilityError(dep.data)) {
    await removeMetaAccount(accountId);
    return {
      ok: false,
      code: "TOP_UP",
      message: toKoreanError(dep.data),
    };
  }

  const waited = await waitUntilConnected(accountId);
  if (!waited.ok) {
    await removeMetaAccount(accountId);
    return {
      ok: false,
      code: waited.code,
      message: toKoreanError(waited.message, waited.message),
    };
  }

  const snap = await fetchSnapshot(accountId);
  if (!snap.ok) {
    await removeMetaAccount(accountId);
    return snap;
  }
  return snap;
}

/**
 * Create MetaAPI account and verify broker login.
 * Tries regular g1 first (no high-reliability top-up required), then g2.
 */
export async function provisionTradingAccount(input: {
  login: string;
  password: string;
  server: string;
  reuseAccountId?: string | null;
}): Promise<MetaSnap | MetaErr> {
  if (!token()) {
    return {
      ok: false,
      code: "NO_TOKEN",
      message: "MetaAPI 토큰이 설정되지 않았습니다. 관리자에게 문의하세요.",
    };
  }

  if (input.reuseAccountId) {
    await api(PROVISIONING, "PUT", `/users/current/accounts/${input.reuseAccountId}`, {
      password: input.password,
      login: input.login,
      name: `SA-${input.login}`,
      server: input.server,
    });
    await deployAccount(input.reuseAccountId);
    const waited = await waitUntilConnected(input.reuseAccountId);
    if (!waited.ok) {
      return { ok: false, code: waited.code, message: toKoreanError(waited.message, waited.message) };
    }
    return fetchSnapshot(input.reuseAccountId);
  }

  const profileId = await ensureProvisioningProfile();
  const modes = provisionModes();
  let lastErr: MetaErr | null = null;

  for (const mode of modes) {
    const result = await createAndConnect({
      login: input.login,
      password: input.password,
      server: input.server,
      profileId,
      mode,
    });
    if (result.ok) return result;

    lastErr = result;
    // Retry next mode on billing / reliability / create failures
    const retryable =
      result.code === "TOP_UP" ||
      isTopUpOrHighReliabilityError(result.message) ||
      result.code === "CREATE_FAILED" ||
      result.code === "UNKNOWN";
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
    if (!retryable) {
      return {
        ok: false,
        code: result.code,
        message: toKoreanError(result.message, result.message),
      };
    }
    // continue to next mode for top-up / create issues
  }

  return (
    lastErr || {
      ok: false,
      code: "UNKNOWN",
      message: "클라우드 계좌 연동에 실패했습니다. MetaAPI 잔액·구독을 확인하세요.",
    }
  );
}

function mapPositions(raw: unknown[]): MetaSnap["positions"] {
  return raw.map((p) => {
    const x = p as Record<string, unknown>;
    const type = String(x.type || x.positionType || "");
    const direction: "BUY" | "SELL" =
      type.toLowerCase().includes("sell") || type === "POSITION_TYPE_SELL" ? "SELL" : "BUY";
    return {
      id: String(x.id || x.positionId || ""),
      symbol: String(x.symbol || ""),
      direction,
      lots: Number(x.volume || x.lots || 0),
      price: Number(x.openPrice || x.price || 0),
      profit: Number(x.profit || 0) + Number(x.swap || 0) + Number(x.commission || 0),
      magic: x.magic != null ? Number(x.magic) : undefined,
    };
  });
}

export async function fetchSnapshot(metaApiAccountId: string): Promise<MetaSnap | MetaErr> {
  const bases = [clientBase(), "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai"];
  let info: unknown = null;
  let positionsRaw: unknown[] = [];

  for (const base of bases) {
    const infoRes = await api(
      base,
      "GET",
      `/users/current/accounts/${metaApiAccountId}/account-information`,
    );
    if (infoRes.status < 400) {
      info = infoRes.data;
      const posRes = await api(base, "GET", `/users/current/accounts/${metaApiAccountId}/positions`);
      positionsRaw = Array.isArray(posRes.data) ? posRes.data : [];
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

  const bases = [clientBase(), "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai"];
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
  const bases = [clientBase(), "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai"];
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

export async function closeAllPositions(metaApiAccountId: string) {
  const snap = await fetchSnapshot(metaApiAccountId);
  if (!snap.ok) return snap;
  const results: Array<{ id: string; ok: boolean; message?: string }> = [];
  for (const p of snap.positions) {
    if (!p.id) continue;
    const r = await closePosition(metaApiAccountId, p.id);
    results.push({ id: p.id, ok: r.ok, message: r.ok ? undefined : r.message });
  }
  return { ok: true as const, results, closed: results.filter((r) => r.ok).length };
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
