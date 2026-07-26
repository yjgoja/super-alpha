/**
 * Shared live account state cache.
 *
 * Write path: engine (after MetaAPI/stream snap)
 * Read path: web UI (?live=1) — avoid MetaAPI credits
 *
 * Backends (first available wins for read merge):
 * 1) Redis when REDIS_URL / KV_URL is set
 * 2) Postgres BrokerAccount.liveState (always, cross-process)
 * 3) Process memory (same-process L1)
 */
import type { Prisma } from "@prisma/client";
import Redis from "ioredis";
import { prisma } from "./db";
import type { MetaSnap } from "./metaapi";

export type CachedPosition = {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  price: number;
  profit: number;
  margin?: number;
  magic?: number;
  stopLoss?: number;
  takeProfit?: number;
};

export type AccountLiveState = {
  v: 1;
  accountId: string;
  metaApiAccountId: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  currency: string;
  connectionStatus?: string;
  positions: CachedPosition[];
  updatedAt: string;
};

const memByMeta = new Map<string, AccountLiveState>();
const memByAccount = new Map<string, AccountLiveState>();

let redis: Redis | null | undefined;

function redisEnabled() {
  const url = (process.env.REDIS_URL || process.env.KV_URL || "").trim();
  return url.length > 0 && process.env.STATE_CACHE_REDIS !== "0";
}

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  if (!redisEnabled()) {
    redis = null;
    return null;
  }
  try {
    const url = (process.env.REDIS_URL || process.env.KV_URL || "").trim();
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    redis.on("error", (e) => {
      console.warn("[state-cache] redis error", e instanceof Error ? e.message : e);
    });
    return redis;
  } catch (e) {
    console.warn(
      "[state-cache] redis init failed",
      e instanceof Error ? e.message : e,
    );
    redis = null;
    return null;
  }
}

function redisKeyMeta(metaApiAccountId: string) {
  return `sa:live:meta:${metaApiAccountId}`;
}

function redisKeyAccount(accountId: string) {
  return `sa:live:acct:${accountId}`;
}

function ttlSeconds() {
  return Math.max(30, Number(process.env.STATE_CACHE_TTL_SEC || 120));
}

export function defaultUiCacheMaxAgeMs() {
  return Math.max(3_000, Number(process.env.STATE_CACHE_UI_MAX_AGE_MS || 20_000));
}

function isFresh(state: AccountLiveState, maxAgeMs: number) {
  const at = Date.parse(state.updatedAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= maxAgeMs;
}

function normalizeState(raw: unknown): AccountLiveState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<AccountLiveState>;
  if (s.v !== 1) return null;
  if (!s.metaApiAccountId || !s.accountId) return null;
  if (typeof s.balance !== "number" || typeof s.equity !== "number") return null;
  if (!Array.isArray(s.positions) || !s.updatedAt) return null;
  return {
    v: 1,
    accountId: String(s.accountId),
    metaApiAccountId: String(s.metaApiAccountId),
    balance: Number(s.balance) || 0,
    equity: Number(s.equity) || 0,
    margin: Number(s.margin) || 0,
    freeMargin: Number(s.freeMargin) || 0,
    leverage: Number(s.leverage) || 0,
    currency: String(s.currency || "USD"),
    connectionStatus: s.connectionStatus ? String(s.connectionStatus) : undefined,
    positions: s.positions.map((p) => ({
      id: String(p.id || ""),
      symbol: String(p.symbol || ""),
      direction: (p.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
      lots: Number(p.lots) || 0,
      price: Number(p.price) || 0,
      profit: Number(p.profit) || 0,
      margin: p.margin != null ? Number(p.margin) : undefined,
      magic: p.magic != null ? Number(p.magic) : undefined,
      stopLoss: p.stopLoss != null ? Number(p.stopLoss) : undefined,
      takeProfit: p.takeProfit != null ? Number(p.takeProfit) : undefined,
    })),
    updatedAt: String(s.updatedAt),
  };
}

/** Engine / successful MetaAPI snap → publish for UI readers. */
export async function setAccountLiveState(input: {
  accountId: string;
  metaApiAccountId: string;
  balance: number;
  equity: number;
  margin?: number;
  freeMargin?: number;
  leverage?: number;
  currency?: string;
  connectionStatus?: string;
  positions: CachedPosition[];
}): Promise<AccountLiveState> {
  const state: AccountLiveState = {
    v: 1,
    accountId: input.accountId,
    metaApiAccountId: String(input.metaApiAccountId),
    balance: input.balance,
    equity: input.equity,
    margin: input.margin ?? 0,
    freeMargin: input.freeMargin ?? 0,
    leverage: input.leverage ?? 0,
    currency: input.currency || "USD",
    connectionStatus: input.connectionStatus,
    positions: input.positions,
    updatedAt: new Date().toISOString(),
  };

  memByMeta.set(state.metaApiAccountId, state);
  memByAccount.set(state.accountId, state);

  const r = getRedis();
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      const payload = JSON.stringify(state);
      const ttl = ttlSeconds();
      await Promise.all([
        r.set(redisKeyMeta(state.metaApiAccountId), payload, "EX", ttl),
        r.set(redisKeyAccount(state.accountId), payload, "EX", ttl),
      ]);
    } catch (e) {
      console.warn(
        "[state-cache] redis set failed",
        e instanceof Error ? e.message : e,
      );
    }
  }

  try {
    await prisma.brokerAccount.update({
      where: { id: state.accountId },
      data: {
        liveState: state as unknown as Prisma.InputJsonValue,
        liveStateAt: new Date(state.updatedAt),
        balance: state.balance,
        equity: state.equity,
        lastSyncAt: new Date(state.updatedAt),
      },
    });
  } catch (e) {
    // Column lag: still keep balance/equity so UI/engine equity sync never stalls.
    console.warn(
      "[state-cache] postgres liveState set failed — falling back to equity only",
      e instanceof Error ? e.message : e,
    );
    try {
      await prisma.brokerAccount.update({
        where: { id: state.accountId },
        data: {
          balance: state.balance,
          equity: state.equity,
          lastSyncAt: new Date(state.updatedAt),
        },
      });
    } catch (e2) {
      console.warn(
        "[state-cache] postgres equity fallback failed",
        e2 instanceof Error ? e2.message : e2,
      );
    }
  }

  return state;
}

export async function getAccountLiveStateByMetaId(
  metaApiAccountId: string,
  maxAgeMs = defaultUiCacheMaxAgeMs(),
): Promise<AccountLiveState | null> {
  const id = String(metaApiAccountId);

  const mem = memByMeta.get(id);
  if (mem && isFresh(mem, maxAgeMs)) return mem;

  const r = getRedis();
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      const raw = await r.get(redisKeyMeta(id));
      const parsed = raw ? normalizeState(JSON.parse(raw)) : null;
      if (parsed && isFresh(parsed, maxAgeMs)) {
        memByMeta.set(id, parsed);
        memByAccount.set(parsed.accountId, parsed);
        return parsed;
      }
    } catch (e) {
      console.warn(
        "[state-cache] redis get failed",
        e instanceof Error ? e.message : e,
      );
    }
  }

  try {
    const row = await prisma.brokerAccount.findFirst({
      where: { metaApiAccountId: id },
      select: { id: true, liveState: true, liveStateAt: true },
    });
    const parsed = normalizeState(row?.liveState);
    if (parsed && isFresh(parsed, maxAgeMs)) {
      memByMeta.set(id, parsed);
      memByAccount.set(parsed.accountId, parsed);
      return parsed;
    }
  } catch (e) {
    console.warn(
      "[state-cache] postgres get failed",
      e instanceof Error ? e.message : e,
    );
  }

  return null;
}

export async function getAccountLiveStateByAccountId(
  accountId: string,
  maxAgeMs = defaultUiCacheMaxAgeMs(),
): Promise<AccountLiveState | null> {
  const mem = memByAccount.get(accountId);
  if (mem && isFresh(mem, maxAgeMs)) return mem;

  const r = getRedis();
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      const raw = await r.get(redisKeyAccount(accountId));
      const parsed = raw ? normalizeState(JSON.parse(raw)) : null;
      if (parsed && isFresh(parsed, maxAgeMs)) {
        memByMeta.set(parsed.metaApiAccountId, parsed);
        memByAccount.set(accountId, parsed);
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const row = await prisma.brokerAccount.findUnique({
      where: { id: accountId },
      select: { liveState: true },
    });
    const parsed = normalizeState(row?.liveState);
    if (parsed && isFresh(parsed, maxAgeMs)) {
      memByMeta.set(parsed.metaApiAccountId, parsed);
      memByAccount.set(accountId, parsed);
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Convert cache → MetaSnap shape for UI readers. */
export function liveStateToMetaSnap(state: AccountLiveState): MetaSnap {
  return {
    ok: true,
    metaApiAccountId: state.metaApiAccountId,
    balance: state.balance,
    equity: state.equity,
    margin: state.margin,
    freeMargin: state.freeMargin,
    leverage: state.leverage,
    currency: state.currency,
    name: "",
    server: "",
    login: "",
    connectionStatus: state.connectionStatus,
    positions: state.positions,
    fromStateCache: true,
    stateCacheAt: state.updatedAt,
  };
}
