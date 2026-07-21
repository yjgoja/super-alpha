/**
 * HTTP fallback engine — Vercel cron endpoint를 2초마다 호출.
 * 로컬에 DB 없이 CRON_SECRET만으로도 가능.
 */
const INTERVAL_MS = Math.max(1500, Number(process.env.ENGINE_INTERVAL_MS || 2000));
const TICK_URL =
  process.env.TICK_URL || "https://www.superalpha.kr/api/cron/tick";
const SECRET = process.env.CRON_SECRET || "";

async function tick() {
  if (!SECRET) throw new Error("CRON_SECRET required");
  const res = await fetch(TICK_URL, {
    headers: { Authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(55_000),
  });
  const text = await res.text();
  console.log(`[http-rt] ${res.status}`, text.slice(0, 400));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

console.log(`[http-rt] start ${INTERVAL_MS}ms → ${TICK_URL}`);
tick().catch((e) => console.error(e));
setInterval(() => tick().catch((e) => console.error(e)), INTERVAL_MS);
