import { NextResponse } from "next/server";
import { runAllBots } from "@/lib/meta-engine";
import { undeployIdleAccounts } from "@/lib/cost-optimize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Auth: Authorization Bearer CRON_SECRET only.
 * Do NOT trust x-vercel-cron alone (spoofable). Query ?secret= removed (URL leak risk).
 * GHA bot-tick sends Bearer; set BOT_TICK_URL without query params.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const idle = await undeployIdleAccounts(24);
  const results = await runAllBots({
    budgetMs: 52_000,
    skipIdleUndeploy: true,
  });
  return NextResponse.json({
    ok: true,
    count: results.length,
    results,
    idleUndeploy: idle,
  });
}
