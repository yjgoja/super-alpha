import { NextRequest, NextResponse } from "next/server";
import { requireApprovedUser, requireUser } from "@/lib/access";
import { effectiveDayKey, isDemoHomeLogin } from "@/lib/demo-clock";
import { ensureTradingSchema, prisma } from "@/lib/db";
import { resolveActiveBrokerAccount, resolveEditableBrokerAccount } from "@/lib/account-selection";
import { gateErrorKo } from "@/lib/ko-errors";
import { fetchSnapshotCached, syncMt5Account } from "@/lib/metaapi";
import { syncTodayPnlFromMt5Deals } from "@/lib/mt5-pnl-sync";
import { publicBotStatusMessage, isAlarmStatusMessage } from "@/lib/public-status";
import { loadOpenBurstSettings } from "@/lib/open-burst-settings";
import { redactFillNote } from "@/lib/strategy-public";

export const maxDuration = 60;
export const runtime = "nodejs";

/** Throttle expensive MT5 deal history sync (engine already updates daily PnL). */
const PNL_SYNC_MIN_MS = 60_000;
const lastPnlSyncAt = new Map<string, number>();

/**
 * Soft equity sync only — never run trading ticks from the UI.
 * Engine (Render) owns ENTRY/DCA/TP/SL; multi-instance ticks caused soft-close storms.
 */
export async function POST(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const body = await req.json().catch(() => ({}));
  const targetAccountId =
    typeof body?.accountId === "string" ? body.accountId : undefined;
  const account = await resolveEditableBrokerAccount({
    userId: gate.user.id,
    role: gate.user.role,
    accountId: targetAccountId,
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

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
  });
}

type LivePos = Extract<Awaited<ReturnType<typeof fetchSnapshotCached>>, { ok: true }>["positions"];

async function pullLiveSnapshot(opts: {
  accountId: string;
  metaApiAccountId: string;
  botEnabled: boolean;
  startingBalance: number;
  wantPnlSync: boolean;
}): Promise<{
  livePositions: LivePos;
  syncError: string | null;
  liveDailyPnl: number | null;
  fromStateCache: boolean;
  balance?: number;
  equity?: number;
  lastSyncAt?: Date;
  status?: string;
  statusMessage?: string | null;
}> {
  const metaId = opts.metaApiAccountId;
  let livePositions: LivePos = [];
  let liveDailyPnl: number | null = null;

  // Prefers engine state cache; MetaAPI only on miss/stale. Never wake cloud deploy.
  const snap = await fetchSnapshotCached(metaId);
  if (!snap.ok) {
    return { livePositions, syncError: snap.message, liveDailyPnl, fromStateCache: false };
  }

  const fromStateCache = snap.fromStateCache === true;

  // Cache already wrote balance/equity/lastSyncAt — skip redundant write when fresh.
  let updated: {
    balance: number;
    equity: number;
    lastSyncAt: Date | null;
    status: string;
    statusMessage: string | null;
  };
  if (fromStateCache) {
    updated = {
      balance: snap.balance,
      equity: snap.equity,
      lastSyncAt: snap.stateCacheAt ? new Date(snap.stateCacheAt) : new Date(),
      status: "connected",
      // Keep existing public message; engine owns statusMessage writes.
      statusMessage: null,
    };
  } else {
    updated = await prisma.brokerAccount.update({
      where: { id: opts.accountId },
      data: {
        balance: snap.balance,
        equity: snap.equity,
        lastSyncAt: new Date(),
        status: "connected",
        ...(opts.botEnabled ? { statusMessage: "클라우드 연결 · 봇 실행 중" } : {}),
      },
    });
  }

  livePositions = snap.positions;

  // Deal history is slow — only when explicitly requested and throttled
  if (opts.wantPnlSync) {
    const prev = lastPnlSyncAt.get(opts.accountId) || 0;
    if (Date.now() - prev >= PNL_SYNC_MIN_MS) {
      lastPnlSyncAt.set(opts.accountId, Date.now());
      const synced = await syncTodayPnlFromMt5Deals({
        accountId: opts.accountId,
        metaApiAccountId: metaId,
        equity: snap.equity,
        startingBalance: opts.startingBalance,
      });
      if (synced.ok) liveDailyPnl = synced.dayPnl;
    }
  }

  // Engine already snapshots equity ~60s; skip when serving shared cache.
  if (!fromStateCache) {
    const recent = await prisma.equitySnapshot.findFirst({
      where: { accountId: opts.accountId },
      orderBy: { createdAt: "desc" },
    });
    if (!recent || Date.now() - recent.createdAt.getTime() > 50_000) {
      await prisma.equitySnapshot.create({
        data: {
          accountId: opts.accountId,
          equity: snap.equity,
          balance: snap.balance,
        },
      });
    }
  }

  return {
    livePositions,
    syncError: null,
    liveDailyPnl,
    fromStateCache,
    balance: updated.balance,
    equity: updated.equity,
    lastSyncAt: updated.lastSyncAt ?? undefined,
    status: updated.status,
    // Only push statusMessage when we wrote it (MetaAPI fallback path).
    statusMessage: fromStateCache ? undefined : updated.statusMessage,
  };
}

/**
 * Fast path: DB only. Pass ?live=1 for positions + equity (state cache preferred, MetaAPI fallback).
 * ?live=1&lite=1 — light payload for heartbeat / home (no fills/snapshots history).
 * ?pnl=1 — also refresh today's PnL from MT5 deals (throttled).
 * Bot OFF여도 연결된 계좌의 열린 포지션을 표시한다.
 */
export async function GET(req: NextRequest) {
  await ensureTradingSchema();
  const gate = await requireUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const wantLive = req.nextUrl.searchParams.get("live") === "1";
  const wantSummary = req.nextUrl.searchParams.get("summary") === "1";
  const wantLite = req.nextUrl.searchParams.get("lite") === "1";
  const wantPnlSync = req.nextUrl.searchParams.get("pnl") === "1";
  const wantFull = req.nextUrl.searchParams.get("full") === "1";
  const targetAccountId = req.nextUrl.searchParams.get("accountId");

  const resolveTarget = () =>
    resolveEditableBrokerAccount({
      userId: gate.user!.id,
      role: gate.user!.role,
      accountId: targetAccountId,
    });

  // Home hero: light query (no baskets/fills/snapshots)
  if (wantSummary && !wantLive) {
    const _active = await resolveTarget();
    const asOf = effectiveDayKey(_active?.login);
    const account = _active
      ? await prisma.brokerAccount.findUnique({
          where: { id: _active.id },
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
            skipOpenBurstEntries: true,
            balance: true,
            equity: true,
            startingBalance: true,
            tpCount: true,
            slCount: true,
            cycleCount: true,
            dailyStats: {
              where: { date: asOf },
              take: 1,
              select: { date: true, pnl: true, returnPct: true },
            },
          },
        })
      : null;
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
    const burst = await loadOpenBurstSettings(account.id);

    return NextResponse.json({
      role: gate.user.role,
      today: asOf,
      demoClock: isDemoHomeLogin(account.login),
      account: {
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
        skipOpenBurstEntries: burst.skipOpenBurstEntries,
        openBurstOnTrigger: burst.openBurstOnTrigger,
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

  // Lite live: MetaAPI equity/positions + open baskets only (heartbeat / home)
  if (wantLive && wantLite) {
    const _activeLite = await resolveTarget();
    const asOfLite = effectiveDayKey(_activeLite?.login);
    const account = _activeLite
      ? await prisma.brokerAccount.findUnique({
          where: { id: _activeLite.id },
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
            baskets: {
              where: { status: "open" },
              select: {
                id: true,
                symbol: true,
                direction: true,
                status: true,
                unrealizedPnl: true,
              },
            },
            dailyStats: {
              where: { date: asOfLite },
              take: 1,
              select: { date: true, pnl: true, returnPct: true },
            },
          },
        })
      : null;

    if (!account) {
      return NextResponse.json({ role: gate.user.role, account: null });
    }

    let livePositions: LivePos = [];
    let syncError: string | null = null;
    let liveDailyPnl: number | null = null;
    let liveFromCache = false;

    if (!account.metaApiAccountId) {
      syncError = "MetaAPI에 연결된 실계좌가 없습니다.";
    } else {
      const pulled = await pullLiveSnapshot({
        accountId: account.id,
        metaApiAccountId: String(account.metaApiAccountId),
        botEnabled: account.botEnabled,
        startingBalance: account.startingBalance,
        wantPnlSync,
      });
      livePositions = pulled.livePositions;
      syncError = pulled.syncError;
      liveDailyPnl = pulled.liveDailyPnl;
      liveFromCache = pulled.fromStateCache;
      if (pulled.balance != null) account.balance = pulled.balance;
      if (pulled.equity != null) account.equity = pulled.equity;
      if (pulled.lastSyncAt) account.lastSyncAt = pulled.lastSyncAt;
      if (pulled.status) account.status = pulled.status;
      if (pulled.statusMessage !== undefined) account.statusMessage = pulled.statusMessage;
    }

    const start =
      account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
    const today = account.dailyStats[0] ?? null;
    const dailyPnl = liveDailyPnl ?? today?.pnl ?? 0;
    const dailyReturnPct =
      liveDailyPnl != null && start > 0
        ? (liveDailyPnl / start) * 100
        : (today?.returnPct ?? 0);
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
        dailyReturnPct,
        dailyPnl,
        baskets: account.baskets,
        livePositions,
        liveFromCache,
        syncError:
          account.botEnabled || !syncError || isAlarmStatusMessage(syncError)
            ? null
            : syncError,
      },
    });
  }

  const _activeFull = await resolveTarget();
  const account = _activeFull
    ? await prisma.brokerAccount.findUnique({
        where: { id: _activeFull.id },
        include: wantFull
          ? {
              config: true,
              baskets: { where: { status: "open" }, include: { legs: true } },
              fills: { orderBy: { createdAt: "desc" }, take: 20 },
              snapshots: { orderBy: { createdAt: "desc" }, take: 48 },
              dailyStats: { orderBy: { date: "desc" }, take: 14 },
            }
          : {
              baskets: {
                where: { status: "open" },
                select: {
                  id: true,
                  symbol: true,
                  direction: true,
                  status: true,
                  unrealizedPnl: true,
                },
              },
              fills: { orderBy: { createdAt: "desc" }, take: 10 },
              dailyStats: { orderBy: { date: "desc" }, take: 7 },
            },
      })
    : null;
  if (!account) {
    return NextResponse.json({
      role: gate.user.role,
      account: null,
    });
  }

  let livePositions: LivePos = [];
  let syncError: string | null = null;
  let liveDailyPnl: number | null = null;
  let liveFromCache = false;

  if (wantLive) {
    if (!account.metaApiAccountId) {
      syncError = "MetaAPI에 연결된 실계좌가 없습니다.";
    } else {
      const pulled = await pullLiveSnapshot({
        accountId: account.id,
        metaApiAccountId: String(account.metaApiAccountId),
        botEnabled: account.botEnabled,
        startingBalance: account.startingBalance,
        wantPnlSync,
      });
      livePositions = pulled.livePositions;
      syncError = pulled.syncError;
      liveDailyPnl = pulled.liveDailyPnl;
      liveFromCache = pulled.fromStateCache;
      if (pulled.balance != null) account.balance = pulled.balance;
      if (pulled.equity != null) account.equity = pulled.equity;
      if (pulled.lastSyncAt) account.lastSyncAt = pulled.lastSyncAt;
      if (pulled.status) account.status = pulled.status;
      if (pulled.statusMessage !== undefined) account.statusMessage = pulled.statusMessage;
    }
  }

  const start =
    account.startingBalance > 0 ? account.startingBalance : account.balance || 1;
  const totalReturnPct = ((account.equity - start) / start) * 100;
  const todayKey = effectiveDayKey(account.login);
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
  const fullAccount = account as typeof account & {
    config?: unknown;
    snapshots?: Array<{ createdAt: Date } & Record<string, unknown>>;
  };

  return NextResponse.json({
    role: gate.user.role,
    account: {
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
      totalReturnPct,
      dailyReturnPct,
      dailyPnl,
      // Strategy config / leg lots / fill notes are IP — admin only + full
      ...(isAdmin && wantFull
        ? {
            config: fullAccount.config,
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
            })),
            fills: account.fills.map((f) => ({
              id: f.id,
              symbol: f.symbol,
              side: f.side,
              pnl: f.pnl,
              kind: f.kind,
              note: redactFillNote(f.note),
              createdAt: f.createdAt,
            })),
          }),
      snapshots: wantFull && fullAccount.snapshots ? [...fullAccount.snapshots].reverse() : [],
      dailyStats: account.dailyStats,
      livePositions: wantLive ? livePositions : undefined,
      liveFromCache: wantLive ? liveFromCache : undefined,
      syncError: wantLive ? syncError : undefined,
    },
  });
}
