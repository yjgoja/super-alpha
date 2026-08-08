/**
 * Fetch MetaAPI 1m candles (broker OHLC + spread) — highest resolution available.
 * Historical ticks return [] on this cloud-g2 / Zero Markets account.
 */
import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

const TOKEN = process.env.METAAPI_TOKEN?.trim() || "";
const REGION = "london"; // account region
const START = "2026-01-01T00:00:00.000Z";
const END = new Date().toISOString();

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  spread?: number;
  tickVolume?: number;
};

async function fetchAll(accountId: string, symbol: string): Promise<Candle[]> {
  const base = `https://mt-market-data-client-api-v1.${REGION}.agiliumtrade.ai`;
  const all: Candle[] = [];
  let cursor = END; // candles load backwards
  for (let page = 0; page < 400; page++) {
    const u =
      `${base}/users/current/accounts/${accountId}/historical-market-data/symbols/${encodeURIComponent(symbol)}/timeframes/1m/candles` +
      `?startTime=${encodeURIComponent(cursor)}&limit=1000`;
    const res = await fetch(u, {
      headers: { "auth-token": TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(symbol, res.status, text.slice(0, 200));
      break;
    }
    const rows = JSON.parse(text) as Candle[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    let oldest = rows[0].time;
    for (const r of rows) {
      if (r.time < START || r.time >= END) continue;
      all.push({
        time: r.time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        spread: r.spread,
        tickVolume: r.tickVolume,
      });
      if (r.time < oldest) oldest = r.time;
    }
    if (page % 20 === 0 || rows.length < 1000) {
      console.log(`  ${symbol} p${page + 1} kept=${all.length} oldest=${oldest}`);
    }
    if (oldest <= START || rows.length < 1000) break;
    cursor = oldest;
  }
  const map = new Map(all.map((r) => [r.time, r]));
  return [...map.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function main() {
  const acc = await prisma.brokerAccount.findFirst({
    where: { metaApiAccountId: { not: null } },
  });
  if (!acc?.metaApiAccountId) throw new Error("no account");
  const outDir = path.join(process.cwd(), "scripts", "out");
  fs.mkdirSync(outDir, { recursive: true });

  // 공장이 실제로 거래하는 4종목 전부. EURUSD/XAUUSD 만 받으면 나머지는
  // 합성 데이터로 떨어진다 (bars.ts getBarsForSymbol 폴백).
  for (const symbol of ["EURUSD", "GBPUSD", "AUDUSD", "XAUUSD"] as const) {
    console.log(`\nFetching ${symbol} 1m (region=${REGION})...`);
    let bars = await fetchAll(acc.metaApiAccountId, symbol);
    if (!bars.length && symbol === "XAUUSD") {
      console.log("retry GOLD...");
      bars = await fetchAll(acc.metaApiAccountId, "GOLD");
    }
    console.log(`→ ${bars.length} ${bars[0]?.time} ~ ${bars.at(-1)?.time}`);
    fs.writeFileSync(path.join(outDir, `ohlc-${symbol}-M1.json`), JSON.stringify(bars));
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
