-- Revert SL basket-ROI default 525% -> 225% (small-account protection: cut losses
-- earlier). Bounded basket size is enforced primarily by the entryCount level cap.
ALTER TABLE "SymbolBot" ALTER COLUMN "stopLossPct" SET DEFAULT 225;

-- Bring rows that were bumped to 525 back down to 225.
UPDATE "SymbolBot" SET "stopLossPct" = 225 WHERE "stopLossPct" = 525;
