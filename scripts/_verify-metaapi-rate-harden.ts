/**
 * Offline checks for MetaAPI rate-limit / stream-first hardening.
 * Run: npx tsx scripts/_verify-metaapi-rate-harden.ts
 *
 * Does NOT call MetaAPI or touch live baskets.
 */
import {
  clearMetaApiRateLimitState,
  metaApiRateLimited,
  noteMetaApiRateLimit,
  priceRestFallbackAllowed,
  symbolsMatch,
} from "../src/lib/metaapi";
import { resolveEngineConcurrency } from "../src/lib/meta-engine";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

clearMetaApiRateLimitState();
check("rate limit clear", !metaApiRateLimited() && !metaApiRateLimited("acc-a"));

noteMetaApiRateLimit(60_000, "acc-a");
check("account A paused", metaApiRateLimited("acc-a"));
check("soft global active after account 429", metaApiRateLimited());
check(
  "peer briefly REST-gated by soft global (stream paths still allowed in code)",
  metaApiRateLimited("acc-b"),
);

clearMetaApiRateLimitState();
noteMetaApiRateLimit(60_000); // legacy global-only
check("legacy global pause", metaApiRateLimited());
check("legacy global also gates account check", metaApiRateLimited("acc-z"));
clearMetaApiRateLimitState();

const prevEngine = process.env.ENGINE_MODE;
const prevPriceRest = process.env.METAAPI_PRICE_REST;
const prevConc = process.env.ENGINE_CONCURRENCY;
const prevVercel = process.env.VERCEL;

process.env.ENGINE_MODE = "direct";
delete process.env.METAAPI_PRICE_REST;
check("direct engine defaults PRICE_REST off", priceRestFallbackAllowed() === false);

process.env.METAAPI_PRICE_REST = "1";
check("PRICE_REST=1 forces on", priceRestFallbackAllowed() === true);

process.env.METAAPI_PRICE_REST = "0";
check("PRICE_REST=0 forces off", priceRestFallbackAllowed() === false);

delete process.env.ENGINE_MODE;
delete process.env.METAAPI_PRICE_REST;
check("non-direct default allows REST fallback", priceRestFallbackAllowed() === true);

delete process.env.ENGINE_CONCURRENCY;
process.env.VERCEL = "1";
check("vercel default concurrency 2", resolveEngineConcurrency() === 2);
delete process.env.VERCEL;
process.env.ENGINE_MODE = "direct";
check("direct default concurrency 4", resolveEngineConcurrency() === 4);
process.env.ENGINE_CONCURRENCY = "8";
check("explicit ENGINE_CONCURRENCY wins", resolveEngineConcurrency() === 8);

if (prevEngine == null) delete process.env.ENGINE_MODE;
else process.env.ENGINE_MODE = prevEngine;
if (prevPriceRest == null) delete process.env.METAAPI_PRICE_REST;
else process.env.METAAPI_PRICE_REST = prevPriceRest;
if (prevConc == null) delete process.env.ENGINE_CONCURRENCY;
else process.env.ENGINE_CONCURRENCY = prevConc;
if (prevVercel == null) delete process.env.VERCEL;
else process.env.VERCEL = prevVercel;

check("XAUUSD matches GOLD", symbolsMatch("XAUUSD", "GOLD"));
check("GOLD matches XAUUSD", symbolsMatch("GOLD", "XAUUSD"));
check("EURUSD does not match XAUUSD", !symbolsMatch("EURUSD", "XAUUSD"));

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log("all ok");
