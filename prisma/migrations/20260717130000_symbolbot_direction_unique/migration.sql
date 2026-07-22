-- BUY봇/SELL봇을 종목별로 각각 두기 위해 유니크 키에 direction 추가.
DROP INDEX IF EXISTS "SymbolBot_accountId_symbol_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SymbolBot_accountId_symbol_direction_key"
  ON "SymbolBot"("accountId", "symbol", "direction");
