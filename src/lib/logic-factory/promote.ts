import { prisma } from "@/lib/db";
import type { StrategyPayload } from "@/lib/table-logics";
import { appendAudit } from "./store";
import type { FactoryConfig, RankedCandidate } from "./types";

export type PromoteResult =
  | { ok: true; accountId: string; botId: string; note: string }
  | { ok: false; reason: string };

function envFlag(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Promote winner → StrategyLogic(custom or preset) + SymbolBot.
 * Fail-closed: open baskets, oversized lots, low score, missing account.
 */
export async function promoteWinner(
  winner: RankedCandidate,
  cfg: Pick<
    FactoryConfig,
    "autoPromote" | "minMedianMonthPct" | "minConsistency" | "minScore" | "maxPromoteLots"
  >,
): Promise<PromoteResult> {
  const auto = cfg.autoPromote && envFlag("FACTORY_AUTO_PROMOTE", cfg.autoPromote);
  if (!auto) {
    return { ok: false, reason: "FACTORY_AUTO_PROMOTE off — saved to leaderboard only" };
  }
  if (!winner.runnable) {
    return { ok: false, reason: "sketch not runnable" };
  }
  if (winner.metrics.score < cfg.minScore) {
    return { ok: false, reason: `score ${winner.metrics.score.toFixed(3)} < ${cfg.minScore}` };
  }
  if (winner.metrics.medianMonthReturnPct < cfg.minMedianMonthPct) {
    return {
      ok: false,
      reason: `medianMonth ${winner.metrics.medianMonthReturnPct.toFixed(2)}% < ${cfg.minMedianMonthPct}%`,
    };
  }
  if (winner.metrics.consistency < cfg.minConsistency) {
    return {
      ok: false,
      reason: `consistency ${winner.metrics.consistency.toFixed(3)} < ${cfg.minConsistency}`,
    };
  }

  const lots = Math.min(winner.bot.startLots, cfg.maxPromoteLots);
  if (!(lots > 0) || lots > cfg.maxPromoteLots) {
    return { ok: false, reason: `lots ${lots} exceeds maxPromoteLots ${cfg.maxPromoteLots}` };
  }

  const demoOnly = envFlag("FACTORY_PROMOTE_DEMO_ONLY", false);
  const account = await prisma.brokerAccount.findFirst({
    where: {
      ...(demoOnly
        ? { OR: [{ mode: "demo" }, { server: { contains: "Demo", mode: "insensitive" } }] }
        : {}),
      status: { in: ["connected", "undeployed", "provisioning"] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!account) {
    // broader fallback
    const any = await prisma.brokerAccount.findFirst({ orderBy: { updatedAt: "desc" } });
    if (!any) return { ok: false, reason: "no BrokerAccount" };
    if (demoOnly && !/demo/i.test(any.server) && any.mode !== "demo") {
      return { ok: false, reason: "FACTORY_PROMOTE_DEMO_ONLY — no demo account" };
    }
  }
  const acct = account ?? (await prisma.brokerAccount.findFirst({ orderBy: { updatedAt: "desc" } }));
  if (!acct) return { ok: false, reason: "no BrokerAccount" };

  const open = await prisma.basket.count({
    where: {
      accountId: acct.id,
      symbol: winner.symbol,
      direction: winner.direction,
      status: "open",
    },
  });
  if (open > 0) {
    return {
      ok: false,
      reason: `OPEN_BASKET_FROZEN ${winner.symbol}/${winner.direction} open=${open}`,
    };
  }

  // Prefer custom payload for novel; preset bots keep logic id + startLots/mult
  const logicId = winner.kind === "novel_ladder" ? "custom" : winner.bot.logic;
  const scale = lots / Math.max(0.01, winner.bot.startLots);
  const levels = winner.levels.map((lv) => ({
    lots: Math.max(0.01, Math.round(lv.lots * scale * 100) / 100),
    profit: winner.bot.takeProfitPct,
    drop: lv.drop,
  }));

  const payload: StrategyPayload = {
    mode: "levels",
    startLots: lots,
    takeProfitPct: winner.bot.takeProfitPct,
    stopLossPct: winner.bot.stopLossPct,
    levels,
  };

  await prisma.strategyLogic.upsert({
    where: {
      accountId_logicId: { accountId: acct.id, logicId },
    },
    create: {
      accountId: acct.id,
      logicId,
      name: winner.label.slice(0, 80),
      payload,
    },
    update: {
      name: winner.label.slice(0, 80),
      payload,
    },
  });

  const bot = await prisma.symbolBot.upsert({
    where: {
      accountId_symbol_direction: {
        accountId: acct.id,
        symbol: winner.symbol,
        direction: winner.direction,
      },
    },
    create: {
      accountId: acct.id,
      symbol: winner.symbol,
      direction: winner.direction,
      dualDirection: winner.dualDirection,
      enabled: true,
      logic: logicId,
      startLots: lots,
      entryCount: Math.max(2, levels.length),
      entryMultiplier: winner.bot.entryMultiplier,
      takeProfitPct: winner.bot.takeProfitPct,
      stopLossPct: winner.bot.stopLossPct,
      repeatEnabled: winner.bot.repeatEnabled,
      stopOnSl: winner.bot.stopOnSl,
      stopLossEnabled: true,
    },
    update: {
      dualDirection: winner.dualDirection,
      enabled: true,
      logic: logicId,
      startLots: lots,
      entryCount: Math.max(2, levels.length),
      entryMultiplier: winner.bot.entryMultiplier,
      takeProfitPct: winner.bot.takeProfitPct,
      stopLossPct: winner.bot.stopLossPct,
      repeatEnabled: winner.bot.repeatEnabled,
      stopOnSl: winner.bot.stopOnSl,
      stopLossEnabled: true,
    },
  });

  const note = `promoted ${winner.label} → account=${acct.login} bot=${bot.id} lots=${lots}`;
  appendAudit(note);

  try {
    await prisma.logicFactoryPromotion.create({
      data: {
        accountId: acct.id,
        candidateId: winner.id,
        label: winner.label.slice(0, 120),
        symbol: winner.symbol,
        direction: winner.direction,
        score: winner.metrics.score,
        payload: {
          bot: { ...winner.bot, startLots: lots },
          levels,
          metrics: winner.metrics,
          kind: winner.kind,
        },
        note,
      },
    });
  } catch (e) {
    appendAudit(`PROMOTE_AUDIT_SKIP ${(e as Error).message}`);
  }

  return { ok: true, accountId: acct.id, botId: bot.id, note };
}
