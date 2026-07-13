import { prisma } from "./db";

type Quote = { bid: number; ask: number };

const FALLBACK: Record<string, Quote> = {
  EURUSD: { bid: 1.085, ask: 1.0853 },
  XAUUSD: { bid: 2350.2, ask: 2350.6 },
};

function jitter(q: Quote, vol: number): Quote {
  const mid = (q.bid + q.ask) / 2;
  const shock = (Math.random() - 0.5) * 2 * vol * mid;
  const spread = Math.max(q.ask - q.bid, mid * 0.00002);
  const n = mid + shock;
  return { bid: n - spread / 2, ask: n + spread / 2 };
}

async function fetchFrankfurter(): Promise<Quote | null> {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD", {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: { USD?: number } };
    const mid = data.rates?.USD;
    if (!mid || !Number.isFinite(mid)) return null;
    const spread = 0.00028; // ~28 pts demo
    return { bid: mid - spread / 2, ask: mid + spread / 2 };
  } catch {
    return null;
  }
}

async function fetchGoldApprox(): Promise<Quote | null> {
  // No reliable free gold API without keys — seed from last tick / fallback + walk
  return null;
}

export async function refreshPrices(): Promise<Record<string, Quote>> {
  const existing = await prisma.priceTick.findMany();
  const map: Record<string, Quote> = {};
  for (const t of existing) {
    map[t.symbol] = { bid: t.bid, ask: t.ask };
  }

  const eur = (await fetchFrankfurter()) ?? jitter(map.EURUSD ?? FALLBACK.EURUSD, 0.0004);
  const xauBase = map.XAUUSD ?? FALLBACK.XAUUSD;
  const xau = (await fetchGoldApprox()) ?? jitter(xauBase, 0.0012);

  const updates = [
    { symbol: "EURUSD", ...eur },
    { symbol: "XAUUSD", ...xau },
  ];

  for (const u of updates) {
    await prisma.priceTick.upsert({
      where: { symbol: u.symbol },
      create: { symbol: u.symbol, bid: u.bid, ask: u.ask },
      update: { bid: u.bid, ask: u.ask },
    });
    map[u.symbol] = { bid: u.bid, ask: u.ask };
  }

  return map;
}

export async function getPrices(): Promise<Record<string, Quote>> {
  const rows = await prisma.priceTick.findMany();
  if (rows.length === 0) return refreshPrices();
  const map: Record<string, Quote> = {};
  for (const r of rows) map[r.symbol] = { bid: r.bid, ask: r.ask };
  return map;
}
