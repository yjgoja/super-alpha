import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/access";
import { dayKeySeoul } from "@/lib/day-key";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { publicBotStatusMessage } from "@/lib/public-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Keep SSE open on Vercel Fluid; clients reconnect after this. */
export const maxDuration = 60;

const TICK_MS = 2000;

/**
 * Near-realtime equity/PnL from DB (engine + MetaAPI syncs write here).
 * Does not call MetaAPI — pair with BotHeartbeat's occasional ?live=1 for positions.
 */
export async function GET(req: NextRequest) {
  if (process.env.LIVE_SSE_ENABLED === "0") {
    return NextResponse.json(
      { error: "Live SSE disabled (LIVE_SSE_ENABLED=0)" },
      { status: 503 },
    );
  }

  const gate = await requireUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const userId = gate.user.id;
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const onAbort = () => {
        closed = true;
      };
      req.signal.addEventListener("abort", onAbort);

      send({ type: "hello", at: new Date().toISOString() });
      let lastFingerprint = "";
      let tick = 0;

      while (!closed && !req.signal.aborted) {
        try {
          tick += 1;
          // Baskets every ~3rd tick — equity/scalars every tick
          const includeBaskets = tick === 1 || tick % 3 === 0;
          const account = await prisma.brokerAccount.findFirst({
            where: { userId },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              login: true,
              server: true,
              mode: true,
              status: true,
              statusMessage: true,
              metaApiAccountId: true,
              lastSyncAt: true,
              botEnabled: true,
              balance: true,
              equity: true,
              startingBalance: true,
              tpCount: true,
              slCount: true,
              cycleCount: true,
              ...(includeBaskets
                ? {
                    baskets: {
                      where: { status: "open" as const },
                      select: {
                        id: true,
                        symbol: true,
                        direction: true,
                        status: true,
                        unrealizedPnl: true,
                      },
                    },
                  }
                : {}),
              dailyStats: {
                where: { date: dayKeySeoul() },
                take: 1,
                select: { date: true, pnl: true, returnPct: true },
              },
            },
          });

          if (!account) {
            const payload = {
              type: "live",
              source: "sse",
              account: null,
              at: new Date().toISOString(),
            };
            const fp = JSON.stringify(payload.account);
            if (fp !== lastFingerprint) {
              lastFingerprint = fp;
              send(payload);
            }
          } else {
            const start =
              account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
            const today = account.dailyStats[0] ?? null;
            const syncAgeSec = account.lastSyncAt
              ? Math.max(0, Math.floor((Date.now() - account.lastSyncAt.getTime()) / 1000))
              : null;
            const baskets =
              "baskets" in account
                ? (account as { baskets?: unknown[] }).baskets
                : undefined;

            const accountPayload = {
              id: account.id,
              login: account.login,
              server: account.server,
              mode: account.mode,
              status: account.status,
              statusMessage: publicBotStatusMessage({
                botEnabled: account.botEnabled,
                status: account.status,
                statusMessage: account.statusMessage,
              }),
              metaApiAccountId: account.metaApiAccountId,
              lastSyncAt: account.lastSyncAt,
              syncAgeSec,
              botEnabled: account.botEnabled,
              balance: account.balance,
              equity: account.equity,
              startingBalance: account.startingBalance,
              tpCount: account.tpCount,
              slCount: account.slCount,
              cycleCount: account.cycleCount,
              totalReturnPct: ((account.equity - start) / start) * 100,
              dailyReturnPct: today?.returnPct ?? 0,
              dailyPnl: today?.pnl ?? 0,
              ...(baskets ? { baskets } : {}),
            };
            // Skip identical equity frames to cut client work
            const fp = `${account.equity}|${account.balance}|${today?.pnl ?? 0}|${account.status}|${account.botEnabled}|${baskets ? baskets.length : "-"}`;
            if (fp !== lastFingerprint) {
              lastFingerprint = fp;
              send({
                type: "live",
                source: "sse",
                at: new Date().toISOString(),
                account: accountPayload,
              });
            }
          }
        } catch (e) {
          send({
            type: "error",
            message: e instanceof Error ? e.message : "stream error",
            at: new Date().toISOString(),
          });
        }

        await new Promise((r) => setTimeout(r, TICK_MS));
      }

      req.signal.removeEventListener("abort", onAbort);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
