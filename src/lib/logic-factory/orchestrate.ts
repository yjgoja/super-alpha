import type { StrategyGenomeV1 } from "@/lib/strategy-inventor";
import { getBarsForSymbol, strideBars } from "./bars";
import {
  inventNovelCandidates,
  inventPresetParamCandidates,
  inventSketchCandidates,
} from "./param-search";
import { promoteWinner } from "./promote";
import { simulateCandidate } from "./simulate";
import { appendAudit, factoryOutDir, persistEpoch } from "./store";
import { maybeSendFactoryDailyTelegram } from "./telegram";
import type {
  FactoryCandidate,
  FactoryConfig,
  FactoryEpochResult,
  RankedCandidate,
} from "./types";

export function defaultFactoryConfig(partial?: Partial<FactoryConfig>): FactoryConfig {
  const autoPromote =
    process.env.FACTORY_AUTO_PROMOTE === "0"
      ? false
      : process.env.FACTORY_AUTO_PROMOTE === "1"
        ? true
        : (partial?.autoPromote ?? true);
  return {
    runId: partial?.runId ?? `run-${new Date().toISOString().slice(0, 10)}`,
    symbols: partial?.symbols ?? ["GBPUSD", "EURUSD"],
    seeds: partial?.seeds ?? [1000, 2000],
    generationSize: partial?.generationSize ?? 24,
    novelRatio: partial?.novelRatio ?? 0.45,
    sketchRatio: partial?.sketchRatio ?? 0.1,
    eliteCount: partial?.eliteCount ?? 4,
    minMedianMonthPct: partial?.minMedianMonthPct ?? 3,
    minConsistency: partial?.minConsistency ?? 0.5,
    minScore: partial?.minScore ?? 5,
    maxPromoteLots: partial?.maxPromoteLots ?? 0.05,
    barStride: partial?.barStride ?? 15,
    continuous: partial?.continuous ?? false,
    sleepMs: partial?.sleepMs ?? 5_000,
    autoPromote,
    maxGenerations: partial?.maxGenerations ?? (partial?.continuous ? 0 : 1),
    dryPromote: partial?.dryPromote ?? false,
  };
}

function rankAll(
  candidates: FactoryCandidate[],
  barsBySymbol: Map<string, ReturnType<typeof strideBars>>,
  seeds: number[],
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    if (!c.runnable) continue;
    const bars = barsBySymbol.get(c.symbol);
    if (!bars?.length) continue;
    const metrics = simulateCandidate(c, bars, seeds);
    ranked.push({ ...c, metrics });
  }
  ranked.sort((a, b) => b.metrics.score - a.metrics.score);
  return ranked;
}

export async function runFactoryGeneration(opts: {
  cfg: FactoryConfig;
  epoch: number;
  generation: number;
  parents?: StrategyGenomeV1[];
  /** skip DB promote (verify) */
  dryPromote?: boolean;
}): Promise<FactoryEpochResult> {
  const { cfg, epoch, generation } = opts;
  const t0 = Date.now();
  const outDir = factoryOutDir(cfg.runId);

  const nNovel = Math.max(1, Math.round(cfg.generationSize * cfg.novelRatio));
  const nSketch = Math.max(0, Math.round(cfg.generationSize * cfg.sketchRatio));
  const nParam = Math.max(1, cfg.generationSize - nNovel);

  const seedBase = (epoch * 100_000 + generation * 997 + cfg.runId.length * 13) >>> 0;

  const param = inventPresetParamCandidates({
    seed: seedBase,
    count: nParam,
    symbols: cfg.symbols,
  });
  const novel = inventNovelCandidates({
    seed: seedBase ^ 0xabc,
    count: nNovel,
    symbols: cfg.symbols,
    parents: opts.parents,
  });
  const sketches = inventSketchCandidates({
    seed: seedBase ^ 0xdef,
    count: nSketch,
    symbols: cfg.symbols,
  });

  const barsBySymbol = new Map<string, ReturnType<typeof strideBars>>();
  for (const sym of cfg.symbols) {
    const { bars, source } = getBarsForSymbol(sym, seedBase);
    barsBySymbol.set(sym, strideBars(bars, cfg.barStride));
    appendAudit(`bars ${sym} n=${bars.length} stride=${cfg.barStride} source=${source}`);
  }

  const ranked = rankAll([...param, ...novel], barsBySymbol, cfg.seeds);
  // attach sketches into tested count but not ranked
  const tested = param.length + novel.length + sketches.length;
  const top = ranked.slice(0, 20);
  const best = top[0] ?? null;

  const result: FactoryEpochResult = {
    runId: cfg.runId,
    epoch,
    generation,
    tested,
    precise: ranked.length,
    elapsedMs: Date.now() - t0,
    best,
    top,
    outDir,
  };
  persistEpoch(result);

  // Persist sketches summary
  const fs = await import("fs");
  const path = await import("path");
  fs.writeFileSync(
    path.join(outDir, `sketches-gen-${generation}.json`),
    JSON.stringify(
      sketches.map((s) => ({ id: s.id, label: s.label, meta: s.meta })),
      null,
      2,
    ),
  );

  if (best && !opts.dryPromote && !cfg.dryPromote) {
    try {
      const promo = await promoteWinner(best, cfg);
      appendAudit(
        promo.ok
          ? `PROMOTE_OK ${promo.note}`
          : `PROMOTE_SKIP ${promo.reason} · best=${best.label}`,
      );
    } catch (e) {
      appendAudit(`PROMOTE_ERR ${(e as Error).message} · best=${best.label}`);
    }
  } else if (best && (opts.dryPromote || cfg.dryPromote)) {
    appendAudit(`PROMOTE_DRY best=${best.label} score=${best.metrics.score.toFixed(3)}`);
  }

  return result;
}

export async function runFactoryLoop(cfg: FactoryConfig) {
  let epoch = 1;
  let generation = 1;
  let parents: StrategyGenomeV1[] = [];

  const maxGen = cfg.maxGenerations > 0 ? cfg.maxGenerations : Number.POSITIVE_INFINITY;

  while (generation <= maxGen) {
    console.log(
      `\n🏭 factory epoch=${epoch} gen=${generation} size=${cfg.generationSize} autoPromote=${cfg.autoPromote}`,
    );
    const result = await runFactoryGeneration({
      cfg,
      epoch,
      generation,
      parents,
    });
    console.log(
      `   tested=${result.tested} ranked=${result.precise} elapsed=${result.elapsedMs}ms`,
    );
    if (result.best) {
      const m = result.best.metrics;
      console.log(
        `   BEST ${result.best.label}\n   score=${m.score.toFixed(3)} medianMonth=${m.medianMonthReturnPct.toFixed(2)}% consistency=${m.consistency.toFixed(3)} dd=${m.maxDrawdownPct.toFixed(1)}%`,
      );
      parents = result.top
        .filter((c) => c.kind === "novel_ladder")
        .slice(0, cfg.eliteCount)
        .map((c) => c.meta.genome as StrategyGenomeV1)
        .filter(Boolean);
    }

    // Continuous discovery never Telegram-spams.
    // Daily digest is GHA `logic-factory-daily` at KST 12:00 only
    // (`scripts/logic-factory-daily-report.ts --force`).
    // Opt-in: FACTORY_TELEGRAM_FROM_WORKER=1 enables noon gate inside the loop.
    if (process.env.FACTORY_TELEGRAM_FROM_WORKER === "1") {
      try {
        const tg = await maybeSendFactoryDailyTelegram();
        if (tg.sent) {
          console.log(`   📬 telegram daily ok ${tg.dayKey}`);
        } else if (
          tg.reason &&
          !tg.reason.startsWith("outside") &&
          tg.reason !== "telegram not configured"
        ) {
          console.log(`   📬 telegram skip: ${tg.reason}`);
        }
      } catch (e) {
        appendAudit(`TELEGRAM_DAILY_ERR ${(e as Error).message}`);
      }
    }

    generation += 1;
    if (generation % 10 === 1) epoch += 1;

    if (!cfg.continuous && generation > cfg.maxGenerations) break;
    if (cfg.continuous && generation <= maxGen) {
      await new Promise((r) => setTimeout(r, cfg.sleepMs));
    } else if (!cfg.continuous) {
      break;
    }
  }
}
