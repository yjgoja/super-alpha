/**
 * Direct realtime engine — MetaAPI + DB on this machine (lowest latency).
 * Prefer this over HTTP mode for 즉각 익절/물타기/손절.
 *
 *   DATABASE_URL=... METAAPI_TOKEN=... ENGINE_INTERVAL_MS=2000
 *   npm run engine:direct
 */
import { runAllBots } from "../src/lib/meta-engine";

const INTERVAL_MS = Math.max(1500, Number(process.env.ENGINE_INTERVAL_MS || 2000));

let running = false;
let ticks = 0;

async function tick() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const results = await runAllBots();
    ticks += 1;
    console.log(
      `[direct] #${ticks} ${Date.now() - t0}ms accounts=${results.length}`,
      JSON.stringify(results).slice(0, 500),
    );
  } catch (e) {
    console.error(`[direct] error`, e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

console.log(`[direct] start interval=${INTERVAL_MS}ms pid=${process.pid}`);
tick();
setInterval(tick, INTERVAL_MS);
