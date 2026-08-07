/**
 * MetaAPI HTTP call counters — cost regression guard for the engine.
 * Log once per minute from tick-direct / stream supervisor.
 */

type Bucket = {
  snapshot: number;
  price: number;
  history: number;
  trade: number;
  other: number;
  errors: number;
};

const totals: Bucket = {
  snapshot: 0,
  price: 0,
  history: 0,
  trade: 0,
  other: 0,
  errors: 0,
};

let windowStart = Date.now();
const window: Bucket = { ...totals };

/**
 * Per-status × category error breakdown.
 *
 * The aggregate `err=` counter told us 8-14 MetaAPI calls a minute were failing
 * but not which ones, so the cause stayed unknown. Key is `${status}:${category}`
 * (e.g. "429:price", "0:snapshot") — enough to separate rate limits from
 * network drops from genuine 4xx without logging account ids or URLs.
 */
const errorDetail = new Map<string, number>();

function classify(pathName: string, method: string): keyof Bucket {
  const p = pathName.toLowerCase();
  if (p.includes("account-information") || p.includes("/positions")) return "snapshot";
  if (p.includes("current-price") || p.includes("/symbols/")) return "price";
  if (p.includes("history-deals") || p.includes("historical")) return "history";
  if (method === "POST" && p.includes("/trade")) return "trade";
  return "other";
}

export function recordMetaApiHttp(opts: {
  method: string;
  pathName: string;
  status: number;
}) {
  const key = classify(opts.pathName, opts.method);
  totals[key] += 1;
  window[key] += 1;
  if (opts.status >= 400 || opts.status === 0) {
    totals.errors += 1;
    window.errors += 1;
    // 심볼까지 붙여야 "어느 종목이 404인지"가 보인다. 계좌 id/URL 은 남기지 않는다.
    const sym = opts.pathName.match(/\/symbols\/([^/?]+)/)?.[1];
    const detailKey = sym ? `${opts.status}:${key}:${decodeURIComponent(sym)}` : `${opts.status}:${key}`;
    errorDetail.set(detailKey, (errorDetail.get(detailKey) ?? 0) + 1);
  }
}

/** Error breakdown for the current window, busiest first. */
export function peekMetaApiErrorDetail() {
  return [...errorDetail.entries()].sort((a, b) => b[1] - a[1]);
}

export function peekMetaApiHttpWindow() {
  const elapsedMs = Math.max(1, Date.now() - windowStart);
  const perMin = (n: number) => Math.round((n * 60_000) / elapsedMs);
  return {
    elapsedMs,
    window: { ...window },
    perMinute: {
      snapshot: perMin(window.snapshot),
      price: perMin(window.price),
      history: perMin(window.history),
      trade: perMin(window.trade),
      other: perMin(window.other),
      errors: perMin(window.errors),
      total: perMin(
        window.snapshot + window.price + window.history + window.trade + window.other,
      ),
    },
    totals: { ...totals },
  };
}

export function resetMetaApiHttpWindow() {
  windowStart = Date.now();
  window.snapshot = 0;
  window.price = 0;
  window.history = 0;
  window.trade = 0;
  window.other = 0;
  window.errors = 0;
  errorDetail.clear();
}

export function logMetaApiHttpWindow(tag = "metaapi-http") {
  const snap = peekMetaApiHttpWindow();
  const detail = peekMetaApiErrorDetail();
  console.log(
    `[${tag}] perMin total=${snap.perMinute.total} snap=${snap.perMinute.snapshot} price=${snap.perMinute.price} hist=${snap.perMinute.history} trade=${snap.perMinute.trade} err=${snap.perMinute.errors} windowSec=${Math.round(snap.elapsedMs / 1000)}`,
  );
  if (detail.length > 0) {
    console.log(
      `[${tag}-err] ${detail.map(([k, n]) => `${k}=${n}`).join(" ")}`,
    );
  }
  resetMetaApiHttpWindow();
  return snap;
}
