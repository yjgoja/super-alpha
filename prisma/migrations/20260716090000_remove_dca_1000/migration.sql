-- Remove dca_1000 preset: migrate bots/overrides to dubai_bruno_313 (identical levels)

UPDATE "SymbolBot" SET "logic" = 'dubai_bruno_313' WHERE "logic" = 'dca_1000';

-- Prefer existing dubai override; otherwise rename dca_1000 → dubai_bruno_313
DELETE FROM "StrategyLogic" AS dca
WHERE dca."logicId" = 'dca_1000'
  AND EXISTS (
    SELECT 1 FROM "StrategyLogic" AS dubai
    WHERE dubai."accountId" = dca."accountId"
      AND dubai."logicId" = 'dubai_bruno_313'
  );

UPDATE "StrategyLogic" SET "logicId" = 'dubai_bruno_313' WHERE "logicId" = 'dca_1000';

ALTER TABLE "SymbolBot" ALTER COLUMN "logic" SET DEFAULT 'dubai_bruno_313';
