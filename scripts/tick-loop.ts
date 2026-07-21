/**
 * Always-on tick worker — calls Vercel /api/cron/tick every few seconds.
 * No Next.js/src imports (keeps `next build` typecheck clean).
 *
 *   CRON_SECRET=...
 *   TICK_URL=https://www.superalpha.kr/api/cron/tick
 *   ENGINE_INTERVAL_MS=2000
 *   npm run engine
 */
const INTERVAL_MS = Math.max(
  1500,
  Number(process.env.ENGINE_INTERVAL_MS || process.env.RT_INTERVAL_MS || 2000),
);
const TICK_URL =
  process.env.TICK_URL ||
  process.env.BOT_TICK_URL ||
  "https://www.superalpha.kr/api/cron/tick";
const SECRET = process.env.CRON_SECRET || "";

let running = false;
let ticks = 0;

async function tick() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    if (!SECRET) throw new Error("CRON_SECRET required");
    const res = await fetch(TICK_URL, {
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(55_000),
    });
    const text = await res.text();
    ticks += 1;
    console.log(
      `[rt] #${ticks} ${Date.now() - t0}ms HTTP ${res.status}`,
      text.slice(0, 400),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`[rt] error`, e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

console.log(`[rt] start interval=${INTERVAL_MS}ms → ${TICK_URL}`);
tick();
setInterval(tick, INTERVAL_MS);
