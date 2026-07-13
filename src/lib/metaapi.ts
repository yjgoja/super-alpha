/**
 * MetaAPI (metaapi.cloud) — real MT5 credential validation + account snapshot.
 * Requires METAAPI_TOKEN from https://app.metaapi.cloud/token
 */
import fs from "fs";
import path from "path";

const PROVISIONING =
  process.env.METAAPI_PROVISIONING_URL ||
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const CLIENT_API =
  process.env.METAAPI_CLIENT_URL ||
  "https://mt-client-api-v1.new-york.agiliumtrade.ai";

export type MetaApiVerifyOk = {
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
  positions: Array<{
    symbol: string;
    direction: "BUY" | "SELL";
    lots: number;
    price: number;
    profit: number;
    level: number;
  }>;
};

export type MetaApiVerifyErr = {
  ok: false;
  code:
    | "NO_TOKEN"
    | "E_AUTH"
    | "E_SRV_NOT_FOUND"
    | "E_SERVER_TIMEZONE"
    | "TIMEOUT"
    | "UNKNOWN";
  message: string;
};

function token() {
  return process.env.METAAPI_TOKEN?.trim() || "";
}

async function api(
  base: string,
  method: string,
  pathName: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const t = token();
  if (!t) throw Object.assign(new Error("METAAPI_TOKEN missing"), { code: "NO_TOKEN" });

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
    data = { raw: text };
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
  if (typeof d.message === "string" && d.message.includes("AUTH")) return "E_AUTH";
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

  if (created.status >= 400) {
    console.error("provisioning profile create failed", created.status, created.data);
    return undefined;
  }

  const profileId =
    (created.data as { id?: string; _id?: string })?.id ||
    (created.data as { id?: string; _id?: string })?._id;
  if (!profileId) return undefined;

  // Upload servers.dat if available (helps Zero Markets detection)
  try {
    const datPath = path.join(process.cwd(), "metaapi", "servers.dat");
    if (fs.existsSync(datPath)) {
      const buf = fs.readFileSync(datPath);
      const form = new FormData();
      form.append(
        "file",
        new Blob([buf], { type: "application/octet-stream" }),
        "servers.dat",
      );
      await fetch(
        `${PROVISIONING}/users/current/provisioning-profiles/${profileId}/servers.dat`,
        {
          method: "PUT",
          headers: { "auth-token": token() },
          body: form,
        },
      );
    }
  } catch (e) {
    console.warn("servers.dat upload skipped", e);
  }

  return profileId;
}

async function waitDeployed(accountId: string, timeoutMs = 50000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(PROVISIONING, "GET", `/users/current/accounts/${accountId}`);
    const state = (res.data as { state?: string; connectionStatus?: string })?.state;
    const connectionStatus = (res.data as { connectionStatus?: string })?.connectionStatus;

    if (res.status === 404) {
      return { ok: false as const, code: "UNKNOWN" as const, message: "계좌 생성 실패" };
    }

    const code = errCode(res.data);
    if (code === "E_AUTH" || connectionStatus === "DISCONNECTED") {
      // keep polling a bit — auth failures often appear as deploy failed
    }

    if (state === "DEPLOYED" && (connectionStatus === "CONNECTED" || connectionStatus === "CONNECTED_NEW_ACCOUNT")) {
      return { ok: true as const };
    }

    if (state === "DEPLOY_FAILED" || state === "DRAFT") {
      const msg =
        code === "E_AUTH"
          ? "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다."
          : `브로커 연결 실패 (${state}${code ? "/" + code : ""})`;
      return {
        ok: false as const,
        code: (code === "E_AUTH" ? "E_AUTH" : "UNKNOWN") as MetaApiVerifyErr["code"],
        message: msg,
      };
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
  return {
    ok: false as const,
    code: "TIMEOUT" as const,
    message: "브로커 연결 시간이 초과되었습니다. 서버명/계좌를 확인하세요.",
  };
}

async function removeAccount(accountId: string) {
  try {
    await api(PROVISIONING, "DELETE", `/users/current/accounts/${accountId}`);
  } catch {
    /* ignore */
  }
}

async function fetchAccountSnapshot(metaApiAccountId: string): Promise<MetaApiVerifyOk | MetaApiVerifyErr> {
  // Deploy account for trading/RPC if needed
  await api(PROVISIONING, "POST", `/users/current/accounts/${metaApiAccountId}/deploy`).catch(
    () => null,
  );

  // Prefer metastats / client account-information
  const infoRes = await api(
    CLIENT_API,
    "GET",
    `/users/current/accounts/${metaApiAccountId}/account-information`,
  );

  if (infoRes.status >= 400) {
    // fallback: try default region host
    const alt = await api(
      "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai",
      "GET",
      `/users/current/accounts/${metaApiAccountId}/account-information`,
    );
    if (alt.status >= 400) {
      return {
        ok: false,
        code: "UNKNOWN",
        message: "계좌 정보를 가져오지 못했습니다. MetaAPI 연결을 확인하세요.",
      };
    }
    return mapInfo(metaApiAccountId, alt.data, []);
  }

  const posRes = await api(
    CLIENT_API,
    "GET",
    `/users/current/accounts/${metaApiAccountId}/positions`,
  );
  const positions = Array.isArray(posRes.data) ? posRes.data : [];

  return mapInfo(metaApiAccountId, infoRes.data, positions);
}

function mapInfo(
  metaApiAccountId: string,
  info: unknown,
  positionsRaw: unknown[],
): MetaApiVerifyOk {
  const i = (info || {}) as Record<string, unknown>;
  const positions = positionsRaw.map((p) => {
    const x = p as Record<string, unknown>;
    const type = String(x.type || x.positionType || "");
    const direction: "BUY" | "SELL" =
      type.toLowerCase().includes("sell") || type === "POSITION_TYPE_SELL"
        ? "SELL"
        : "BUY";
    return {
      symbol: String(x.symbol || ""),
      direction,
      lots: Number(x.volume || x.lots || 0),
      price: Number(x.openPrice || x.price || 0),
      profit: Number(x.profit || 0) + Number(x.swap || 0),
      level: 0,
    };
  });

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
    positions,
  };
}

/**
 * Validate MT5 login/password/server by creating a temporary MetaAPI cloud account.
 * On auth failure the account is removed and an error is returned.
 */
export async function verifyMt5Credentials(input: {
  login: string;
  password: string;
  server: string;
  reuseAccountId?: string | null;
}): Promise<MetaApiVerifyOk | MetaApiVerifyErr> {
  if (!token()) {
    return {
      ok: false,
      code: "NO_TOKEN",
      message:
        "MetaAPI 토큰이 없습니다. https://app.metaapi.cloud/token 에서 발급 후 METAAPI_TOKEN을 설정하세요.",
    };
  }

  // Reuse existing MetaAPI account if we have one (update password / redeploy)
  if (input.reuseAccountId) {
    const upd = await api(
      PROVISIONING,
      "PUT",
      `/users/current/accounts/${input.reuseAccountId}`,
      {
        password: input.password,
        login: input.login,
        name: `SA-${input.login}`,
        server: input.server,
      },
    );
    if (upd.status < 400) {
      await api(
        PROVISIONING,
        "POST",
        `/users/current/accounts/${input.reuseAccountId}/deploy`,
      ).catch(() => null);
      const waited = await waitDeployed(input.reuseAccountId);
      if (!waited.ok) {
        if (waited.code === "E_AUTH") return waited;
      } else {
        return fetchAccountSnapshot(input.reuseAccountId);
      }
    }
  }

  const profileId = await ensureProvisioningProfile();

  const payload: Record<string, unknown> = {
    name: `SA-${input.login}`,
    type: "cloud",
    login: input.login,
    password: input.password,
    server: input.server,
    platform: "mt5",
    magic: 20260713,
    quoteStreamingIntervalInSeconds: 2.5,
    reliability: "regular",
  };
  if (profileId) payload.provisioningProfileId = profileId;

  const created = await api(PROVISIONING, "POST", "/users/current/accounts", payload, {
    "transaction-id": `sa-${input.login}-${Date.now()}`,
  });

  if (created.status >= 400) {
    const code = errCode(created.data);
    if (code === "E_AUTH") {
      return {
        ok: false,
        code: "E_AUTH",
        message: "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.",
      };
    }
    if (code === "E_SRV_NOT_FOUND") {
      return {
        ok: false,
        code: "E_SRV_NOT_FOUND",
        message: `서버 '${input.server}' 를 MetaAPI에서 찾지 못했습니다. 서버명을 확인하세요.`,
      };
    }
    return {
      ok: false,
      code: "UNKNOWN",
      message:
        (created.data as { message?: string })?.message ||
        "MetaAPI 계좌 생성에 실패했습니다.",
    };
  }

  const accountId =
    (created.data as { id?: string; _id?: string })?.id ||
    (created.data as { id?: string; _id?: string })?._id;

  if (!accountId) {
    return { ok: false, code: "UNKNOWN", message: "MetaAPI 계좌 ID를 받지 못했습니다." };
  }

  // Deploy
  await api(PROVISIONING, "POST", `/users/current/accounts/${accountId}/deploy`).catch(
    () => null,
  );

  const waited = await waitDeployed(accountId);
  if (!waited.ok) {
    await removeAccount(accountId);
    return waited;
  }

  const snap = await fetchAccountSnapshot(accountId);
  if (!snap.ok) {
    await removeAccount(accountId);
    return snap;
  }

  // Extra safety: login from broker must match
  if (snap.login && snap.login !== input.login) {
    await removeAccount(accountId);
    return {
      ok: false,
      code: "E_AUTH",
      message: "브로커에서 반환한 계좌번호가 입력값과 다릅니다.",
    };
  }

  return snap;
}

export async function syncMt5Account(
  metaApiAccountId: string,
): Promise<MetaApiVerifyOk | MetaApiVerifyErr> {
  if (!token()) {
    return {
      ok: false,
      code: "NO_TOKEN",
      message: "METAAPI_TOKEN missing",
    };
  }
  return fetchAccountSnapshot(metaApiAccountId);
}
