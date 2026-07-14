/**
 * Always-on DCA worker — 웹을 닫아도 물타기/익절 실행.
 *
 * HTTP 모드 (권장): Vercel /api/cron/tick 호출
 *   CRON_SECRET=...
 *   TICK_URL=https://super-alpha-inky.vercel.app/api/cron/tick
 *   ENGINE_INTERVAL_MS=5000
 *   npm run engine
 */
const INTERVAL_MS = Math.max(3000, Number(process.env.ENGINE_INTERVAL_MS || 5000));
const TICK_URL =
  process.env.TICK_URL ||
  process.env.BOT_TICK_URL ||
  "https://super-alpha-inky.vercel.app/api/cron/tick";
const SECRET = process.env.CRON_SECRET || "";

async function tickHttp() {
  if (!SECRET) throw new Error("CRON_SECRET required");
  const res = await fetch(TICK_URL, {
    headers: { Authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(55_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tick HTTP ${res.status}: ${text.slice(0, 400)}`);
  console.log(`[engine] http ${res.status}`, text.slice(0, 500));
}

async function tickDirect() {
  const { runAllBots } = await import("../src/lib/meta-engine");
  const results = await runAllBots();
  console.log(`[engine] direct`, JSON.stringify(results).slice(0, 500));
}

async function loop() {
  const mode = SECRET && process.env.ENGINE_DIRECT !== "1" ? "http" : "direct";
  console.log(`[engine] tick ${new Date().toISOString()} mode=${mode}`);
  try {
    if (mode === "http") await tickHttp();
    else await tickDirect();
  } catch (e) {
    console.error("[engine] error", e);
  }
}

console.log(`[engine] start interval=${INTERVAL_MS}ms url=${TICK_URL}`);
loop();
setInterval(loop, INTERVAL_MS);
