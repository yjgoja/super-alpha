/**
 * MetaAPI real-time streaming pool.
 * Terminal state (account info + positions) is local after sync — no REST CPU credits.
 * Trades prefer the streaming connection (not REST /trade) so we do not burn
 * the separate REST trade CPU quota that was blocking re-entry.
 *
 * Docs: https://metaapi.cloud/docs/client/rateLimiting/
 */
import MetaApi from "metaapi.cloud-sdk";
import type { MetaErr, MetaSnap } from "./metaapi";

type TradeResult = {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  error?: string;
  positionId?: string;
  orderId?: string;
};

type StreamConn = {
  connect: () => Promise<unknown>;
  close: () => Promise<void>;
  waitSynchronized: (opts?: { timeoutInSeconds?: number }) => Promise<unknown>;
  synchronized: boolean;
  subscribeToMarketData?: (
    symbol: string,
    subscriptions: Array<{ type: string }>,
    timeoutInSeconds?: number,
  ) => Promise<unknown>;
  createMarketBuyOrder: (
    symbol: string,
    volume: number,
    stopLoss?: number,
    takeProfit?: number,
    options?: { comment?: string },
  ) => Promise<TradeResult>;
  createMarketSellOrder: (
    symbol: string,
    volume: number,
    stopLoss?: number,
    takeProfit?: number,
    options?: { comment?: string },
  ) => Promise<TradeResult>;
  modifyPosition: (
    positionId: string,
    stopLoss?: number,
    takeProfit?: number,
  ) => Promise<TradeResult>;
  closePosition: (
    positionId: string,
    options?: Record<string, unknown>,
  ) => Promise<TradeResult>;
  terminalState: {
    connected: boolean;
    connectedToBroker: boolean;
    accountInformation?: Record<string, unknown> | null;
    positions?: Array<Record<string, unknown>>;
    specifications?: Array<{ symbol?: string } | string>;
    price?: (symbol: string) => { bid?: number; ask?: number } | null;
  };
};

type Handle = {
  conn: StreamConn;
  region: string;
  lastUsed: number;
  ready: boolean;
  symbols: Set<string>;
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
  const candidates = [symbol];
  const u = symbol.toUpperCase();
  if (u === "XAUUSD") candidates.push("GOLD");
  if (u === "GOLD") candidates.push("XAUUSD");
  try {
    for (const sym of candidates) {
      const p = h.conn.terminalState.price(sym);
      const bid = Number(p?.bid || 0);
      const ask = Number(p?.ask || 0);
      if (bid > 0 && ask > 0) {
        h.lastUsed = Date.now();
        return { bid, ask };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readStreamSymbols(metaApiAccountId: string): string[] | null {
  if (!isMetaStreamEnabled()) return null;
  const h = handles.get(String(metaApiAccountId));
  if (!h?.ready) return null;
  const specs = h.conn.terminalState.specifications;
  if (!Array.isArray(specs) || specs.length === 0) return null;
  h.lastUsed = Date.now();
  return specs
    .map((s) => (typeof s === "string" ? s : String(s?.symbol || "")))
    .filter(Boolean);
}

/**
 * Ensure stream + quote subscription, then wait until bid/ask appear (0 REST credits).
 */
export async function waitForStreamPrice(
  metaApiAccountId: string,
  symbols: string[],
  waitMs = 8_000,
): Promise<{ bid: number; ask: number; symbol: string } | null> {
  if (!isMetaStreamEnabled()) return null;
  const id = String(metaApiAccountId);
  const candidates = [
    ...new Set(
      symbols
        .flatMap((s) => {
          const u = s.toUpperCase();
          if (u === "XAUUSD" || u === "GOLD") return ["XAUUSD", "GOLD"];
          return [s];
        })
        .filter(Boolean),
    ),
  ];
  const ok = await ensureStreamConnected(id, null, candidates);
  if (!ok) return null;

  const deadline = Date.now() + Math.max(500, waitMs);
  while (Date.now() < deadline) {
    for (const sym of candidates) {
      const px = readStreamPrice(id, sym);
      if (px) return { ...px, symbol: sym };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function subscribeSymbols(conn: StreamConn, symbols: string[]) {
  if (!conn.subscribeToMarketData) return;
  const expand = (s: string) => {
    const u = s.toUpperCase();
    if (u === "XAUUSD" || u === "GOLD") return ["XAUUSD", "GOLD"];
    return [s];
  };
  const all = [...new Set(symbols.flatMap(expand))];
  for (const symbol of all) {
    if (!symbol) continue;
    try {
      await conn.subscribeToMarketData(symbol, [{ type: "quotes" }], 30);
    } catch {
      // Broker alias — ignore
    }
  }
}

export async function ensureStreamConnected(
  metaApiAccountId: string,
  _region?: string | null,
  symbols: string[] = [],
): Promise<boolean> {
  if (!isMetaStreamEnabled()) return false;
  const id = String(metaApiAccountId);
  const existing = handles.get(id);
  if (existing?.ready) {
    existing.lastUsed = Date.now();
    const newSyms = symbols.filter((s) => s && !existing.symbols.has(s));
    if (newSyms.length) {
      for (const s of newSyms) existing.symbols.add(s);
      await subscribeSymbols(existing.conn, newSyms);
    }
    return true;
  }
  if (existing?.inflight) return existing.inflight;

  const inflight = (async () => {
    try {
      const api = getApi();
      const account = await api.metatraderAccountApi.getAccount(id);
      // Prefer broker-connected before streaming subscribe
      try {
        const waitConnected = (
          account as { waitConnected?: (timeoutInSeconds?: number) => Promise<unknown> }
        ).waitConnected;
        if (typeof waitConnected === "function") {
          await waitConnected.call(account, 60);
        }
      } catch {
        /* continue — connect may still succeed */
      }
      // Deployed accounts only — do not create
      const conn = account.getStreamingConnection() as unknown as StreamConn;
      await conn.connect();
      await conn.waitSynchronized({ timeoutInSeconds: 90 });
      const symSet = new Set(symbols.filter(Boolean));
      // Also subscribe open position symbols so prices are present for DCA/ENTRY
      const posSyms = (conn.terminalState.positions || [])
        .map((p) => String(p.symbol || ""))
        .filter(Boolean);
      for (const s of posSyms) symSet.add(s);
      await subscribeSymbols(conn, [...symSet]);
      const acctRegion = String(
        (account as { region?: string }).region || "auto",
      );
      handles.set(id, {
        conn,
        region: acctRegion,
        lastUsed: Date.now(),
        ready: true,
        symbols: symSet,
      });
      console.log(
        `[meta-stream] connected ${id.slice(0, 8)}… region=${acctRegion} syms=${[...symSet].join(",") || "-"}`,
      );
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
    symbols: new Set(symbols.filter(Boolean)),
    inflight,
  });
  return inflight;
}

export async function warmStreams(
  accounts: Array<{
    metaApiAccountId: string;
    region?: string | null;
    symbols?: string[];
  }>,
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
        const good = await ensureStreamConnected(
          a.metaApiAccountId,
          a.region,
          a.symbols || [],
        );
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

function tradeOk(res: TradeResult | null | undefined): boolean {
  if (!res || typeof res !== "object") return false;
  if (res.error) return false;
  const n = Number(res.numericCode);
  // MT retcodes: 10008 DONE_PARTIAL, 10009 DONE, 10010 DONE_MONEY
  if (Number.isFinite(n) && n >= 10008 && n <= 10010) return true;
  const s = String(res.stringCode || "");
  return /DONE|PLACED|OK/i.test(s);
}

function tradeFailMessage(res: TradeResult | null | undefined, fallback: string) {
  if (!res) return fallback;
  return String(res.message || res.stringCode || res.error || fallback);
}

async function readyTradeConn(
  metaApiAccountId: string,
  symbol?: string,
): Promise<StreamConn | null> {
  if (!isMetaStreamEnabled()) return null;
  const ok = await ensureStreamConnected(
    metaApiAccountId,
    null,
    symbol ? [symbol] : [],
  );
  if (!ok) return null;
  const h = handles.get(String(metaApiAccountId));
  if (!h?.ready || !h.conn) return null;
  h.lastUsed = Date.now();
  return h.conn;
}

/** Streaming market order — avoids REST /trade CPU credits when connection is live. */
export async function streamPlaceMarketOrder(input: {
  metaApiAccountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  comment?: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
}): Promise<
  | { ok: true; data: TradeResult; via: "stream" }
  | { ok: false; message: string; data?: TradeResult; via: "stream" }
  | null
> {
  const conn = await readyTradeConn(input.metaApiAccountId, input.symbol);
  if (!conn) return null;
  const sl =
    input.stopLoss != null && Number.isFinite(input.stopLoss) && input.stopLoss > 0
      ? input.stopLoss
      : undefined;
  const tp =
    input.takeProfit != null &&
    Number.isFinite(input.takeProfit) &&
    input.takeProfit > 0
      ? input.takeProfit
      : undefined;
  const options = input.comment ? { comment: input.comment } : undefined;
  try {
    const res =
      input.direction === "BUY"
        ? await conn.createMarketBuyOrder(input.symbol, input.lots, sl, tp, options)
        : await conn.createMarketSellOrder(input.symbol, input.lots, sl, tp, options);
    if (tradeOk(res)) return { ok: true, data: res, via: "stream" };
    return {
      ok: false,
      message: tradeFailMessage(res, "스트리밍 주문 실패"),
      data: res,
      via: "stream",
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "스트리밍 주문 예외",
      via: "stream",
    };
  }
}

export async function streamModifyPosition(input: {
  metaApiAccountId: string;
  positionId: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
}): Promise<
  | { ok: true; data: TradeResult; via: "stream" }
  | { ok: false; message: string; data?: TradeResult; via: "stream" }
  | null
> {
  const conn = await readyTradeConn(input.metaApiAccountId);
  if (!conn) return null;
  const sl =
    input.stopLoss != null && Number.isFinite(input.stopLoss) && input.stopLoss > 0
      ? input.stopLoss
      : undefined;
  const tp =
    input.takeProfit != null &&
    Number.isFinite(input.takeProfit) &&
    input.takeProfit > 0
      ? input.takeProfit
      : undefined;
  try {
    const res = await conn.modifyPosition(input.positionId, sl, tp);
    if (tradeOk(res)) return { ok: true, data: res, via: "stream" };
    return {
      ok: false,
      message: tradeFailMessage(res, "스트리밍 TP/SL 수정 실패"),
      data: res,
      via: "stream",
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "스트리밍 TP/SL 예외",
      via: "stream",
    };
  }
}

export async function streamClosePosition(
  metaApiAccountId: string,
  positionId: string,
): Promise<
  | { ok: true; via: "stream" }
  | { ok: false; message: string; via: "stream" }
  | null
> {
  const conn = await readyTradeConn(metaApiAccountId);
  if (!conn) return null;
  try {
    const res = await conn.closePosition(positionId, {});
    if (tradeOk(res)) return { ok: true, via: "stream" };
    return {
      ok: false,
      message: tradeFailMessage(res, "스트리밍 청산 실패"),
      via: "stream",
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "스트리밍 청산 예외",
      via: "stream",
    };
  }
}
