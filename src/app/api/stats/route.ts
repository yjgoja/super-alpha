import { NextRequest, NextResponse } from "next/server";
import { requireApprovedUser, requireUser } from "@/lib/access";
import { dayKeySeoul } from "@/lib/day-key";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { ensureCloudLive, fetchSnapshot, syncMt5Account } from "@/lib/metaapi";
import { runDcaTick } from "@/lib/meta-engine";
import { syncTodayPnlFromMt5Deals } from "@/lib/mt5-pnl-sync";
import { redactFillNote } from "@/lib/strategy-public";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Soft equity sync only — never rebuild baskets (that desynced filledLevel vs engine).
 * When bot is ON, also run one user-scoped DCA tick (supplement to GHA / local engine).
 */
export async function POST() {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    orderBy: { createdAt: "desc" },
  });

  if (!account?.metaApiAccountId) {
    return NextResponse.json({
      ok: false,
      error: "MetaAPI에 연결된 실계좌가 없습니다.",
    });
  }

  const snap = await syncMt5Account(account.metaApiAccountId);
  if (!snap.ok) {
    return NextResponse.json({ ok: false, error: snap.message }, { status: 400 });
  }

  await prisma.brokerAccount.update({
    where: { id: account.id },
    data: {
      balance: snap.balance,
      equity: snap.equity,
      lastSyncAt: new Date(),
      mode: "live",
      status: account.botEnabled ? "connected" : account.status,
    },
  });

  let tick: unknown = null;
  if (account.botEnabled && account.status !== "failed") {
    try {
      tick = await runDcaTick(account.id);
    } catch (e) {
      tick = { ok: false, error: e instanceof Error ? e.message : "tick error" };
    }
  }

  // Tick payload can embed ROI/drop notes — never expose to end users
  const safeTick =
    gate.user.role === "admin"
      ? tick
      : tick && typeof tick === "object"
        ? { ok: (tick as { ok?: boolean }).ok === true }
        : null;

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    tick: safeTick,
  });
}

/**
 * Fast path: DB only. Pass ?live=1 for MetaAPI snapshot (positions + equity).
 * Bot OFF여도 연결된 계좌의 열린 포지션을 표시한다.
 */
export async function GET(req: NextRequest) {
  const gate = await requireUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const wantLive = req.nextUrl.searchParams.get("live") === "1";
  const wantSummary = req.nextUrl.searchParams.get("summary") === "1";

  // Home hero: light query (no baskets/fills/snapshots)
  if (wantSummary && !wantLive) {
    const account = await prisma.brokerAccount.findFirst({
      where: { userId: gate.user.id },
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
        dailyStats: {
          where: { date: dayKeySeoul() },
          take: 1,
          select: { date: true, pnl: true, returnPct: true },
        },
      },
    });

    if (!account) {
      return NextResponse.json({
        role: gate.user.role,
        account: null,
      });
    }

    const start =
      account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
    const totalReturnPct = ((account.equity - start) / start) * 100;
    const today = account.dailyStats[0] ?? null;
    const dailyPnl = today?.pnl ?? 0;
    const dailyReturnPct = today?.returnPct ?? 0;
    const syncAgeSec = account.lastSyncAt
      ? Math.max(0, Math.floor((Date.now() - account.lastSyncAt.getTime()) / 1000))
      : null;

    return NextResponse.json({
      role: gate.user.role,
      account: {
        id: account.id,
        login: account.login,
        server: account.server,
        mode: account.mode,
        status: account.status,
        statusMessage: account.statusMessage,
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
        totalReturnPct,
        dailyReturnPct,
        dailyPnl,
      },
    });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    include: {
      config: true,
      baskets: { where: { status: "open" }, include: { legs: true } },
      fills: { orderBy: { createdAt: "desc" }, take: 20 },
      snapshots: { orderBy: { createdAt: "desc" }, take: 48 },
      dailyStats: { orderBy: { date: "desc" }, take: 14 },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!account) {
    return NextResponse.json({
      role: gate.user.role,
      account: null,
    });
  }

  type LivePos = Extract<Awaited<ReturnType<typeof fetchSnapshot>>, { ok: true }>["positions"];
  let livePositions: LivePos = [];
  let syncError: string | null = null;

  let liveDailyPnl: number | null = null;

  if (wantLive) {
    if (!account.metaApiAccountId) {
      syncError = "MetaAPI에 연결된 실계좌가 없습니다.";
    } else {
      const metaId = String(account.metaApiAccountId);
      // Undeployed accounts cannot read balance — wake cloud, then snapshot
      let snap = await fetchSnapshot(metaId);
      if (!snap.ok) {
        const live = await ensureCloudLive(metaId, 45000);
        if (live.ok && live.snap) {
          snap = live.snap;
        } else if (!live.ok) {
          syncError = live.message || snap.message;
        } else {
          snap = await fetchSnapshot(metaId);
        }
      }

      if (snap.ok) {
        const updated = await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            balance: snap.balance,
            equity: snap.equity,
            lastSyncAt: new Date(),
            // Keep cloud warm while user is viewing live data
            status: "connected",
            // Do NOT overwrite stop reason / engine messages
            ...(account.botEnabled
              ? { statusMessage: "클라우드 연결 · 봇 실행 중" }
              : {}),
          },
        });
        account.balance = updated.balance;
        account.equity = updated.equity;
        account.lastSyncAt = updated.lastSyncAt;
        account.status = updated.status;
        account.statusMessage = updated.statusMessage;
        livePositions = snap.positions;
        syncError = null;

        const synced = await syncTodayPnlFromMt5Deals({
          accountId: account.id,
          metaApiAccountId: metaId,
          equity: snap.equity,
          startingBalance: account.startingBalance,
        });
        if (synced.ok) liveDailyPnl = synced.dayPnl;

        // Persist equity point for charts (throttle: at most ~1/min)
        const recent = await prisma.equitySnapshot.findFirst({
          where: { accountId: account.id },
          orderBy: { createdAt: "desc" },
        });
        if (!recent || Date.now() - recent.createdAt.getTime() > 50_000) {
          await prisma.equitySnapshot.create({
            data: {
              accountId: account.id,
              equity: snap.equity,
              balance: snap.balance,
            },
          });
        }
      } else if (!syncError) {
        syncError = snap.message;
      }
    }
  }

  const start =
    account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
  const totalReturnPct = ((account.equity - start) / start) * 100;
  const todayKey = dayKeySeoul();
  const today =
    account.dailyStats.find((d) => d.date === todayKey) ?? null;
  const dailyPnl = liveDailyPnl ?? today?.pnl ?? 0;
  const dailyReturnPct =
    liveDailyPnl != null && start > 0
      ? (liveDailyPnl / start) * 100
      : (today?.returnPct ?? 0);
  const syncAgeSec = account.lastSyncAt
    ? Math.max(0, Math.floor((Date.now() - account.lastSyncAt.getTime()) / 1000))
    : null;

  const isAdmin = gate.user.role === "admin";

  return NextResponse.json({
    role: gate.user.role,
    account: {
      id: account.id,
      login: account.login,
      server: account.server,
      mode: account.mode,
      status: account.status,
      statusMessage: account.statusMessage,
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
      totalReturnPct,
      dailyReturnPct,
      dailyPnl,
      // Strategy config / leg lots / fill notes are IP — admin only
      ...(isAdmin
        ? {
            config: account.config,
            baskets: account.baskets,
            fills: account.fills,
          }
        : {
            baskets: account.baskets.map((b) => ({
              id: b.id,
              symbol: b.symbol,
              direction: b.direction,
              status: b.status,
              unrealizedPnl: b.unrealizedPnl,
              // omit filledLevel / legs (ladder progress & lots)
            })),
            fills: account.fills.map((f) => ({
              id: f.id,
              symbol: f.symbol,
              side: f.side,
              pnl: f.pnl,
              kind: f.kind,
              note: redactFillNote(f.note),
              createdAt: f.createdAt,
              // omit lots / price / level (reverse-engineers DCA table)
            })),
          }),
      snapshots: account.snapshots.reverse(),
      dailyStats: account.dailyStats,
      livePositions: wantLive ? livePositions : undefined,
      syncError: wantLive ? syncError : undefined,
    },
  });
}
