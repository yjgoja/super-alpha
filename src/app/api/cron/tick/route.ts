import { NextResponse } from "next/server";
import { runAllBots } from "@/lib/meta-engine";
import { undeployIdleAccounts } from "@/lib/cost-optimize";
import { isFxMarketClosed } from "@/lib/market-hours";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 장중 폴링 간격(초) — 호출측(GHA bot-tick)이 이 값을 따른다. */
const POLL_OPEN_SEC = 60;
/**
 * 폐장 폴링 간격(초). 폐장엔 가격이 안 움직여 관리할 것이 없는데도 60초마다
 * 돌면서 DB·MetaAPI 트래픽을 태우고, Render 엔진의 tick lock 까지 뺏었다.
 * 완전히 끄지는 않는다 — 개장 시각을 놓치면 안 되므로 느리게 계속 확인한다.
 */
const POLL_CLOSED_SEC = 600;

/**
 * Auth: Authorization Bearer CRON_SECRET only.
 * Do NOT trust x-vercel-cron alone (spoofable). Query ?secret= removed (URL leak risk).
 * GHA bot-tick sends Bearer; set BOT_TICK_URL without query params.
 *
 * Vercel path is a soft backup: manage-only (no ENTRY/DCA), low concurrency.
 * Primary trading engine is Render tick-direct + METAAPI_STREAM.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 폐장: 실제 틱을 돌리지 않고 다음 폴링을 늦추라고만 알린다.
  // 브로커에 심어둔 TP/SL 은 그대로 살아 있고, 폐장엔 체결이 없다.
  if (isFxMarketClosed()) {
    return NextResponse.json({
      ok: true,
      skipped: "fx_market_closed",
      count: 0,
      nextPollSeconds: POLL_CLOSED_SEC,
    });
  }

  // maxDuration=60 을 넘기면 Vercel 이 인스턴스를 강제 종료하고, 그러면
  // 락 해제 코드가 실행되지 않아 락이 고아로 남는다(= 그 계좌 관리 공백).
  // undeployIdleAccounts 가 예산 밖에서 시간을 먹고 있었으므로, 실제 남은
  // 시간을 재서 runAllBots 예산에 반영한다.
  const startedAt = Date.now();
  const idle = await undeployIdleAccounts(24);
  const elapsed = Date.now() - startedAt;
  const budgetMs = Math.max(5_000, 52_000 - elapsed);
  const results = await runAllBots({
    budgetMs,
    skipIdleUndeploy: true,
    // Fail-closed backup: never open new risk from cold serverless REST ticks.
    forceManageOnly: true,
  });
  return NextResponse.json({
    ok: true,
    count: results.length,
    results,
    idleUndeploy: idle,
    forceManageOnly: true,
    nextPollSeconds: POLL_OPEN_SEC,
  });
}
