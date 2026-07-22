-- 양방향 운용: 한 종목에 BUY·SELL 바스켓을 동시에 돌릴 수 있는 플래그.
ALTER TABLE "SymbolBot" ADD COLUMN "dualDirection" BOOLEAN NOT NULL DEFAULT false;
