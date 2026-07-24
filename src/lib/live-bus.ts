/**
 * Client-side live data bus — one MetaAPI poller (BotHeartbeat) fans out
 * to Home / Market / etc. so screens do not hammer /api/stats?live=1.
 */

export type LiveAccountPatch = {
  equity?: number;
  balance?: number;
  dailyPnl?: number;
  dailyReturnPct?: number;
  totalReturnPct?: number;
  status?: string;
  statusMessage?: string | null;
  botEnabled?: boolean;
  lastSyncAt?: string | Date | null;
  syncAgeSec?: number | null;
  syncError?: string | null;
  livePositions?: Array<{
    id: string;
    symbol: string;
    direction: string;
    lots: number;
    price: number;
    profit: number;
  }>;
  baskets?: unknown[];
  metaApiAccountId?: string | null;
  [key: string]: unknown;
};

export type LiveEventDetail = {
  source: "sse" | "meta" | "db";
  account: LiveAccountPatch | null;
  at?: string;
};

const EVENT = "sa:live";

export function publishLive(detail: LiveEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

export function subscribeLive(cb: (detail: LiveEventDetail) => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<LiveEventDetail>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
