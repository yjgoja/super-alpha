import * as fs from "fs";
import * as path from "path";
import type { FactoryEpochResult, RankedCandidate } from "./types";

export function factoryOutDir(runId: string) {
  const dir = path.join(process.cwd(), "scripts", "out", "logic-factory", runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function persistEpoch(result: FactoryEpochResult) {
  const dir = result.outDir || factoryOutDir(result.runId);
  fs.mkdirSync(dir, { recursive: true });
  const epochPath = path.join(
    dir,
    `epoch-${result.epoch}-gen-${result.generation}.json`,
  );
  fs.writeFileSync(epochPath, JSON.stringify(result, null, 2));

  const board = {
    runId: result.runId,
    epoch: result.epoch,
    generation: result.generation,
    tested: result.tested,
    bestLabel: result.best?.label ?? null,
    bestScore: result.best?.metrics.score ?? null,
    updatedAt: new Date().toISOString(),
    top: result.top.slice(0, 20).map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      score: c.metrics.score,
      medianMonthReturnPct: c.metrics.medianMonthReturnPct,
      consistency: c.metrics.consistency,
      maxDrawdownPct: c.metrics.maxDrawdownPct,
      symbol: c.symbol,
      direction: c.dualDirection ? "DUAL" : c.direction,
    })),
  };
  fs.writeFileSync(path.join(dir, "leaderboard.json"), JSON.stringify(board, null, 2));

  const root = path.join(process.cwd(), "scripts", "out", "logic-factory");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "LATEST.json"),
    JSON.stringify({ ...board, outDir: dir }, null, 2),
  );

  // Must be awaited: a floating promise never settles before a `--once` run
  // (GitHub Actions) exits, so every epoch's DB row was silently dropped.
  if (!process.env.DATABASE_URL) {
    appendAudit("DB_PERSIST_SKIP no DATABASE_URL — results stay file-only");
    console.warn(
      "⚠️ DATABASE_URL 없음 — 이 세대 결과는 DB에 저장되지 않고 승격도 되지 않습니다.",
    );
  } else {
    try {
      await persistEpochToDb(result, board);
    } catch (e) {
      appendAudit(`DB_PERSIST_FAIL ${(e as Error).message}`);
      console.error(`🔴 공장 결과 DB 저장 실패: ${(e as Error).message}`);
    }
  }

  return { epochPath, board };
}

async function persistEpochToDb(
  result: FactoryEpochResult,
  board: Record<string, unknown>,
) {
  if (!process.env.DATABASE_URL) return;
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.logicFactoryRun.upsert({
      where: { runId: result.runId },
      create: {
        runId: result.runId,
        epoch: result.epoch,
        generation: result.generation,
        tested: result.tested,
        bestScore: result.best?.metrics.score ?? null,
        bestLabel: result.best?.label ?? null,
        bestPayload: result.best
          ? {
              bot: result.best.bot,
              levels: result.best.levels,
              metrics: result.best.metrics,
              kind: result.best.kind,
            }
          : undefined,
        leaderboard: board as object,
        status: "running",
      },
      update: {
        epoch: result.epoch,
        generation: result.generation,
        tested: result.tested,
        bestScore: result.best?.metrics.score ?? null,
        bestLabel: result.best?.label ?? null,
        bestPayload: result.best
          ? {
              bot: result.best.bot,
              levels: result.best.levels,
              metrics: result.best.metrics,
              kind: result.best.kind,
            }
          : undefined,
        leaderboard: board as object,
      },
    });
  } catch (e) {
    appendAudit(`DB_PERSIST_SKIP ${(e as Error).message}`);
  }
}

export function loadLeaderboard(runId?: string): {
  runId: string;
  bestScore: number | null;
  bestLabel: string | null;
  outDir?: string;
} | null {
  const root = path.join(process.cwd(), "scripts", "out", "logic-factory");
  const latest = path.join(root, "LATEST.json");
  if (!runId && fs.existsSync(latest)) {
    return JSON.parse(fs.readFileSync(latest, "utf8"));
  }
  if (runId) {
    const p = path.join(root, runId, "leaderboard.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

export function appendAudit(line: string) {
  const root = path.join(process.cwd(), "scripts", "out", "logic-factory");
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(
    path.join(root, "audit.log"),
    `[${new Date().toISOString()}] ${line}\n`,
  );
}

export function rankedToExport(c: RankedCandidate) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    symbol: c.symbol,
    direction: c.direction,
    dualDirection: c.dualDirection,
    bot: c.bot,
    levels: c.levels,
    metrics: c.metrics,
    meta: c.meta,
    autoApply: false,
  };
}
