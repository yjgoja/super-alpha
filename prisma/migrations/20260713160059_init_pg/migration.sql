-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'demo',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "botEnabled" BOOLEAN NOT NULL DEFAULT false,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "equity" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "startingBalance" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "tpCount" INTEGER NOT NULL DEFAULT 0,
    "slCount" INTEGER NOT NULL DEFAULT 0,
    "cycleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyConfig" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "baseLots" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "profitTarget" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "profitScale" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "maxDcaLevel" INTEGER NOT NULL DEFAULT 9,
    "devScale" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "finalSlExtraPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "enableFinalSl" BOOLEAN NOT NULL DEFAULT true,
    "reenterAfterTp" BOOLEAN NOT NULL DEFAULT true,
    "reenterAfterSl" BOOLEAN NOT NULL DEFAULT true,
    "symbols" TEXT NOT NULL DEFAULT 'EURUSD,XAUUSD',

    CONSTRAINT "StrategyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Basket" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "filledLevel" INTEGER NOT NULL DEFAULT 0,
    "firstEntryPrice" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "unrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tradingPaused" BOOLEAN NOT NULL DEFAULT false,
    "lastExitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Basket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasketLeg" (
    "id" TEXT NOT NULL,
    "basketId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "lots" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasketLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "lots" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "level" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquitySnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStat" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startEquity" DOUBLE PRECISION NOT NULL,
    "endEquity" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "returnPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tpCount" INTEGER NOT NULL DEFAULT 0,
    "slCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceTick" (
    "symbol" TEXT NOT NULL,
    "bid" DOUBLE PRECISION NOT NULL,
    "ask" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceTick_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "BrokerAccount_userId_idx" ON "BrokerAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyConfig_accountId_key" ON "StrategyConfig"("accountId");

-- CreateIndex
CREATE INDEX "Basket_accountId_symbol_status_idx" ON "Basket"("accountId", "symbol", "status");

-- CreateIndex
CREATE INDEX "Fill_accountId_createdAt_idx" ON "Fill"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "EquitySnapshot_accountId_createdAt_idx" ON "EquitySnapshot"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStat_accountId_date_key" ON "DailyStat"("accountId", "date");

-- AddForeignKey
ALTER TABLE "BrokerAccount" ADD CONSTRAINT "BrokerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Basket" ADD CONSTRAINT "Basket_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BasketLeg" ADD CONSTRAINT "BasketLeg_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "Basket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquitySnapshot" ADD CONSTRAINT "EquitySnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStat" ADD CONSTRAINT "DailyStat_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
