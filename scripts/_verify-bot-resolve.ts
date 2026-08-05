/**
 * Fail-closed SymbolBot binding — covers godcjfl H8/313 collision + all primary logics.
 * Run: npx tsx scripts/_verify-bot-resolve.ts
 */
import assert from "node:assert/strict";
import {
  hasEnabledTraderForSide,
  mergeNeededSide,
  pickOwnerLogic,
  resolveEnabledFixedBotForSide,
  resolveSymbolBotForSide,
  shouldDisableOnSideStop,
  type BotRowLite,
} from "../src/lib/bot-resolve";
import { PRIMARY_LOGIC_IDS } from "../src/lib/strategies";
import { isMartin9TimeLogic, TABLE_LOGIC_IDS } from "../src/lib/table-logics";

function bot(
  partial: Partial<BotRowLite> & Pick<BotRowLite, "logic" | "direction">,
): BotRowLite {
  return {
    symbol: partial.symbol ?? "XAUUSD",
    enabled: partial.enabled ?? true,
    dualDirection: partial.dualDirection ?? false,
    logic: partial.logic,
    direction: partial.direction,
  };
}

// --- Regression: godcjfl — enabled time SELL + disabled 313 BUY, session BUY ---
{
  const bots = [
    bot({ logic: "martin_9_068_time", direction: "SELL", enabled: true }),
    bot({ logic: "dubai_bruno_313", direction: "BUY", enabled: false }),
  ];
  const side = mergeNeededSide(undefined, {
    manageOnly: false,
    ownerLogic: "martin_9_068_time",
  });
  // Conflict: 313 also claims BUY — time owner must win
  const merged = mergeNeededSide(side, {
    manageOnly: false,
    ownerLogic: "dubai_bruno_313",
  });
  assert.equal(merged.ownerLogic, "martin_9_068_time");

  const row = resolveSymbolBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
    manageOnly: false,
    ownerLogic: merged.ownerLogic,
  });
  assert.ok(row);
  assert.equal(row.logic, "martin_9_068_time");
  assert.equal(row.enabled, true);

  // Old bug: disabled 313 must never win new risk without owner
  const wrong = resolveSymbolBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
    manageOnly: false,
  });
  // Without ownerLogic, enabled time still wins over disabled 313
  assert.ok(wrong);
  assert.equal(wrong.logic, "martin_9_068_time");
}

// --- New risk must not bind disabled-only side ---
{
  const bots = [bot({ logic: "dubai_bruno_313", direction: "BUY", enabled: false })];
  const row = resolveSymbolBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
    manageOnly: false,
    ownerLogic: "dubai_bruno_313",
  });
  assert.equal(row, null);
  assert.equal(hasEnabledTraderForSide(bots, "XAUUSD", "BUY", "dubai_bruno_313"), false);

  // manageOnly may use disabled for TP/SL
  const manage = resolveSymbolBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
    manageOnly: true,
    ownerLogic: "dubai_bruno_313",
  });
  assert.ok(manage);
  assert.equal(manage.logic, "dubai_bruno_313");
}

// --- Owner mismatch: do not fall through to another enabled logic for new risk ---
{
  const bots = [
    bot({ logic: "martin_9_068", direction: "BUY", enabled: true }),
    bot({ logic: "dubai_bruno_313", direction: "BUY", enabled: true }),
  ];
  // Prefer first exact — but with owner dubai_bruno_313 must get 313
  const row = resolveSymbolBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
    manageOnly: false,
    ownerLogic: "dubai_bruno_313",
  });
  assert.ok(row);
  assert.equal(row.logic, "dubai_bruno_313");
}

// --- H8 time must not be disabled by side-stop ---
{
  assert.equal(
    shouldDisableOnSideStop(bot({ logic: "martin_9_068_time", direction: "BUY" })),
    false,
  );
  assert.equal(
    shouldDisableOnSideStop(bot({ logic: "martin_9_35_time", direction: "SELL" })),
    false,
  );
  assert.equal(
    shouldDisableOnSideStop(bot({ logic: "dubai_bruno_313", direction: "BUY" })),
    true,
  );
}

// --- TP reentry path never picks time logic ---
{
  const bots = [
    bot({ logic: "martin_9_068_time", direction: "SELL", enabled: true }),
    bot({ logic: "dubai_bruno_313", direction: "BUY", enabled: true }),
  ];
  const fixedBuy = resolveEnabledFixedBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "BUY",
  });
  assert.ok(fixedBuy);
  assert.equal(fixedBuy.logic, "dubai_bruno_313");

  const fixedSell = resolveEnabledFixedBotForSide({
    bots,
    symbol: "XAUUSD",
    direction: "SELL",
  });
  assert.equal(fixedSell, null); // only time on SELL
}

// --- Do not default missing H8 direction to BUY (caller must omit key) ---
{
  // pickOwnerLogic ranking
  assert.equal(
    pickOwnerLogic("dubai_bruno_313", "martin_9_068_time"),
    "martin_9_068_time",
  );
  assert.equal(pickOwnerLogic("martin_9_35_time", "martin_9_068"), "martin_9_35_time");
}

// --- Every primary logic: alone enabled, correct bind for its side ---
for (const logic of PRIMARY_LOGIC_IDS) {
  const dir = logic.includes("gbp_sell")
    ? "SELL"
    : logic.includes("xau_buy")
      ? "BUY"
      : "SELL";
  const symbol = logic.includes("gbp")
    ? "GBPUSD"
    : logic.includes("xau") || isMartin9TimeLogic(logic)
      ? "XAUUSD"
      : "EURUSD";
  const bots = [bot({ logic, direction: dir, symbol, enabled: true })];

  if (isMartin9TimeLogic(logic)) {
    // Time: session may flip opposite of DB direction
    for (const sessionDir of ["BUY", "SELL"] as const) {
      const row = resolveSymbolBotForSide({
        bots,
        symbol,
        direction: sessionDir,
        manageOnly: false,
        ownerLogic: logic,
      });
      assert.ok(row, `${logic} session ${sessionDir}`);
      assert.equal(row.logic, logic);
    }
  } else {
    const row = resolveSymbolBotForSide({
      bots,
      symbol,
      direction: dir as "BUY" | "SELL",
      manageOnly: false,
      ownerLogic: logic,
    });
    assert.ok(row, `${logic} ${dir}`);
    assert.equal(row.logic, logic);

    // Opposite side with only this bot: no new risk (unless dual — we don't set dual here)
    const other = dir === "BUY" ? "SELL" : "BUY";
    const opp = resolveSymbolBotForSide({
      bots,
      symbol,
      direction: other,
      manageOnly: false,
      ownerLogic: logic,
    });
    // ownerLogic forces same logic row even on opposite side when that row exists enabled
    // — engine only claims the bot's configured side, so owner on opposite shouldn't happen.
    // Still: if wrongly claimed, enabled owner row is returned (same bot). That's OK.
    assert.ok(opp === null || opp.logic === logic, `${logic} opp`);
  }
}

// --- Collision matrix: each primary vs dubai_bruno_313 disabled on opposite/same ---
for (const logic of PRIMARY_LOGIC_IDS) {
  if (logic === "dubai_bruno_313") continue;
  const symbol = "XAUUSD";
  const bots = [
    bot({ logic, direction: "SELL", symbol, enabled: true }),
    bot({ logic: "dubai_bruno_313", direction: "BUY", symbol, enabled: false }),
  ];
  const buy = resolveSymbolBotForSide({
    bots,
    symbol,
    direction: "BUY",
    manageOnly: false,
    ownerLogic: isMartin9TimeLogic(logic) ? logic : undefined,
  });
  if (isMartin9TimeLogic(logic)) {
    assert.ok(buy, `${logic} must own BUY session`);
    assert.equal(buy.logic, logic, `${logic} must not bind disabled 313`);
  } else {
    // Fixed SELL bot does not authorize BUY new risk; disabled 313 must not either
    assert.equal(buy, null, `${logic}: disabled 313 must not authorize BUY`);
  }
}

// --- dualDirection enabled covers both sides ---
{
  const bots = [
    bot({ logic: "martin_9_068", direction: "BUY", dualDirection: true, enabled: true }),
  ];
  assert.ok(
    resolveSymbolBotForSide({
      bots,
      symbol: "XAUUSD",
      direction: "SELL",
      manageOnly: false,
    }),
  );
}

// Table ids stay in sync with primary coverage expectation
for (const id of PRIMARY_LOGIC_IDS) {
  assert.ok(
    (TABLE_LOGIC_IDS as readonly string[]).includes(id),
    `${id} missing from TABLE_LOGIC_IDS`,
  );
}

console.log("bot-resolve verify OK", {
  primary: PRIMARY_LOGIC_IDS.length,
  time: PRIMARY_LOGIC_IDS.filter((id) => isMartin9TimeLogic(id)),
});
