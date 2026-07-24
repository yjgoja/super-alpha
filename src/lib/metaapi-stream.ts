/**
 * MetaAPI real-time streaming pool.
 * Terminal state (account info + positions) is local after sync — no REST CPU credits.
 * Trades still go through REST/RPC (cheap: 10 credits).
 *
 * Docs: https://metaapi.cloud/docs/client/rateLimiting/
 */
import MetaApi from "metaapi.cloud-sdk";
import type { MetaErr, MetaSnap } from "./metaapi";

type StreamConn = {
  connect: () => Promise<unknown>;
  close: () => Promise<void>;
  waitSynchronized: (opts?: { timeoutInSeconds?: number }) => Promise<unknown>;
  synchronized: boolean;
  terminalState: {
    connected: boolean;
    connectedToBroker: boolean;
    accountInformation?: Record<string, unknown> | null;
    positions?: Array<Record<string, unknown>>;
    price?: (symbol: string) => { bid?: number; ask?: number } | null;
  };
};

type Handle = {
  conn: StreamConn;
  region: string;
  lastUsed: number;
  ready: boolean;
  inflight?: Promise<boolean>;
};

const handles = new Map<string, Handle>();
/** JS/Python SDK: do NOT pass region to MetaApi constructor (auto-resolves). */
let sharedApi: InstanceType<typeof MetaApi> | null = null;

function streamEnabled() {
  const v = (process.env.METAAPI_STREAM || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function token() {
  return (process.env.METAAPI_TOKEN || "").trim();
}

function getApi() {
  if (!sharedApi) {
    sharedApi = new MetaApi(token());
  }
  return sharedApi;
}

function mapPositions(raw: Array<Record<string, unknown>>): MetaSnap["positions"] {
  return raw.map((x) => {
    const type = String(x.type || x.positionType || "");
    const direction: "BUY" | "SELL" =
      type.toLowerCase().includes("sell") || type === "POSITION_TYPE_SELL"
        ? "SELL"
        : "BUY";
    const marginRaw = Number(x.margin ?? x.usedMargin ?? 0);
    const slRaw = Number(x.stopLoss ?? x.sl ?? 0);
    const tpRaw = Number(x.takeProfit ?? x.tp ?? 0);
    return {
      id: String(x.id || x.positionId || ""),
      symbol: String(x.symbol || ""),
      direction,
      lots: Number(x.volume || x.lots || 0),
      price: Number(x.openPrice || x.price || 0),
      profit:
        Number(x.profit || 0) + Number(x.swap || 0) + Number(x.commission || 0),
      margin: Number.isFinite(marginRaw) && marginRaw > 0 ? marginRaw : undefined,
      magic: x.magic != null ? Number(x.magic) : undefined,
      stopLoss: Number.isFinite(slRaw) && slRaw > 0 ? slRaw : undefined,
      takeProfit: Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : undefined,
    };
  });
}

export function isMetaStreamEnabled() {
  return streamEnabled() && !!token();
}

/** Synchronous read from local terminal state — 0 REST credits. */
export function readStreamSnapshot(metaApiAccountId: string): MetaSnap | MetaErr | null {
  if (!isMetaStreamEnabled()) return null;
  const id = String(metaApiAccountId);
  const h = handles.get(id);
  if (!h?.ready) return null;
  const ts = h.conn.terminalState;
  if (!ts?.connectedToBroker && !ts?.connected) return null;
  const info = ts.accountInformation;
  if (!info || typeof info !== "object") return null;
  const positionsRaw = Array.isArray(ts.positions) ? ts.positions : [];
  h.lastUsed = Date.now();
  return {
    ok: true,
    metaApiAccountId: id,
    balance: Number(info.balance || 0),
    equity: Number(info.equity || 0),
    margin: Number(info.margin || 0),
    freeMargin: Number(info.freeMargin || 0),
    leverage: Number(info.leverage || 0),
    currency: String(info.currency || "USD"),
    name: String(info.name || ""),
    server: String(info.server || ""),
    login: String(info.login || ""),
    connectionStatus: ts.connectedToBroker ? "CONNECTED" : "DISCONNECTED",
    positions: mapPositions(positionsRaw),
  };
}

export function readStreamPrice(
  metaApiAccountId: string,
  symbol: string,
): { bid: number; ask: number } | null {
  if (!isMetaStreamEnabled()) return null;
  const h = handles.get(String(metaApiAccountId));
  if (!h?.ready || !h.conn.terminalState?.price) return null;
  try {
    const p = h.conn.terminalState.price(symbol);
    const bid = Number(p?.bid || 0);
    const ask = Number(p?.ask || 0);
    if (bid > 0 && ask > 0) {
      h.lastUsed = Date.now();
      return { bid, ask };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function ensureStreamConnected(
  metaApiAccountId: string,
  _region?: string | null,
): Promise<boolean> {
  if (!isMetaStreamEnabled()) return false;
  const id = String(metaApiAccountId);
  const existing = handles.get(id);
  if (existing?.ready) {
    existing.lastUsed = Date.now();
    return true;
  }
  if (existing?.inflight) return existing.inflight;

  const inflight = (async () => {
    try {
      const api = getApi();
      const account = await api.metatraderAccountApi.getAccount(id);
      // Deployed accounts only — do not create
      const conn = account.getStreamingConnection() as unknown as StreamConn;
      await conn.connect();
      await conn.waitSynchronized({ timeoutInSeconds: 90 });
      const acctRegion = String(
        (account as { region?: string }).region || "auto",
      );
      handles.set(id, {
        conn,
        region: acctRegion,
        lastUsed: Date.now(),
        ready: true,
      });
      console.log(`[meta-stream] connected ${id.slice(0, 8)}… region=${acctRegion}`);
      return true;
    } catch (e) {
      handles.delete(id);
      console.warn(
        `[meta-stream] connect fail ${id.slice(0, 8)}…`,
        e instanceof Error ? e.message : e,
      );
      return false;
    }
  })();

  handles.set(id, {
    conn: null as unknown as StreamConn,
    region: "pending",
    lastUsed: Date.now(),
    ready: false,
    inflight,
  });
  return inflight;
}

export async function warmStreams(
  accounts: Array<{ metaApiAccountId: string; region?: string | null }>,
  concurrency = 2,
) {
  if (!isMetaStreamEnabled()) return { ok: 0, fail: 0 };
  const q = [...accounts];
  let ok = 0;
  let fail = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, q.length)) },
    async () => {
      while (q.length) {
        const a = q.shift();
        if (!a) break;
        const good = await ensureStreamConnected(a.metaApiAccountId, a.region);
        if (good) ok += 1;
        else fail += 1;
        // Subscribe rate limits: pause between attaches
        await new Promise((r) => setTimeout(r, 1500));
      }
    },
  );
  await Promise.all(workers);
  return { ok, fail };
}

export function pruneStreams(activeIds: Set<string>, maxIdleMs = 180_000) {
  const now = Date.now();
  for (const [id, h] of handles) {
    if (!activeIds.has(id) || now - h.lastUsed > maxIdleMs) {
      void h.conn?.close?.().catch(() => null);
      handles.delete(id);
      console.log(`[meta-stream] closed ${id.slice(0, 8)}…`);
    }
  }
}

export function streamPoolSize() {
  return handles.size;
}
