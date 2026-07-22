-- SL basket-ROI default 225% -> 525% (must exceed max DCA drop 350% so the
-- full ladder is used and stop-loss only fires at the very end, matching the
-- coin-futures tool).
ALTER TABLE "SymbolBot" ALTER COLUMN "stopLossPct" SET DEFAULT 525;

-- Bump existing rows whose SL is below the deepest drop tier (350%) so they do
-- not stop out mid-ladder. Recompute of stopLossUsd happens lazily on next
-- /api/symbol-bots read (needSlBump migration).
UPDATE "SymbolBot" SET "stopLossPct" = 525, "stopLossEnabled" = true
WHERE "stopLossPct" > 0 AND "stopLossPct" < 350;
