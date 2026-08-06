/**
 * Verify contract-size–aware margin gate math (XAU tiny equity must skip).
 * Run: npx tsx scripts/_verify-margin-gate.ts
 */
import assert from "node:assert/strict";
import { mt5UsedMargin, contractSizeForSymbol } from "../src/lib/dca1000";

{
  assert.equal(contractSizeForSymbol("XAUUSD"), 100);
  assert.equal(contractSizeForSymbol("EURUSD"), 100_000);
}

{
  const xau = mt5UsedMargin({
    symbol: "XAUUSD",
    lots: 0.01,
    avgPrice: 4260,
    brokerLeverage: 500,
  });
  // 0.01 * 100 * 4260 / 500 = 8.52
  assert.ok(Math.abs(xau - 8.52) < 1e-9, `xau margin=${xau}`);
  const equityTiny = 6.67;
  assert.ok(equityTiny < xau * 1.15, "tiny equity must fail gate");
  const equityOk = 1514.81;
  assert.ok(equityOk >= xau * 1.15, "godcjfl equity must pass gate");
}

{
  // Broken formula from prior deploy underestimates XAU ~100x
  const fillPrice = 4260;
  const lots = 0.01;
  const lev = 500;
  const broken = (fillPrice * lots) / lev; // 0.0852
  const correct = mt5UsedMargin({
    symbol: "XAUUSD",
    lots,
    avgPrice: fillPrice,
    brokerLeverage: lev,
  });
  assert.ok(correct / broken > 50, `contract size factor broken=${broken} correct=${correct}`);
}

{
  const eur = mt5UsedMargin({
    symbol: "EURUSD",
    lots: 0.01,
    avgPrice: 1.17,
    brokerLeverage: 500,
  });
  // 0.01 * 100000 * 1.17 / 500 = 2.34
  assert.ok(Math.abs(eur - 2.34) < 1e-9, `eur margin=${eur}`);
}

console.log("margin-gate OK");
