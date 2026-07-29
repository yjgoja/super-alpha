import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/access";
import { gateErrorKo } from "@/lib/ko-errors";
import { loadLeaderboard } from "@/lib/logic-factory";

/** Admin: latest logic-factory leaderboard (file + DB). */
export async function GET() {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const file = loadLeaderboard();
  let db = null as Awaited<ReturnType<typeof prisma.logicFactoryRun.findFirst>> | null;
  try {
    db = await prisma.logicFactoryRun.findFirst({ orderBy: { updatedAt: "desc" } });
  } catch {
    db = null;
  }

  return NextResponse.json({
    file,
    db: db
      ? {
          runId: db.runId,
          epoch: db.epoch,
          generation: db.generation,
          tested: db.tested,
          bestScore: db.bestScore,
          bestLabel: db.bestLabel,
          leaderboard: db.leaderboard,
          updatedAt: db.updatedAt,
        }
      : null,
  });
}
