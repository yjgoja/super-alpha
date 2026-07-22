export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo, toKoreanError } from "@/lib/ko-errors";
import { resolveTpSlUsd } from "@/lib/dca1000";
import {
  LOGIC_IDS,
  LOGIC_OPTIONS,
  SYMBOL_GROUPS,
  SYMBOL_OPTIONS,
  isLogicId,
  normalizeLogicId,
} from "@/lib/strategies";
import {
  defaultEntryMultiplier,
  getTableLevels,
  isBulkLogic,
  isMartinLogic,
  tableLogicMeta,
} from "@/lib/table-logics";
import { healDubaiBrunoOverride, resolveStrategyForAccount } from "@/lib/strategy-resolve";
import type { Prisma } from "@prisma/client";

/** 두바이부르노 전체 회차(L0 포함) — 표에서 파생 (하드코딩 999 금지) */
const DUBAI313_LEVEL_COUNT = tableLogicMeta("dubai_bruno_313").count;
const SYMBOL_SET = new Set(SYMBOL_OPTIONS.map((s) => s.toUpperCase()));

function normalizeSymbol(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function getAccount(userId: string) {
  return prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function GET() {
  try {
    const gate = await requireApprovedUser();
    if (!gate.user) {
      return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
    }
    const account = await getAccount(gate.user.id);
    if (!account) {
      return NextResponse.json({
        bots: [],
        options: { symbols: SYMBOL_OPTIONS, groups: SYMBOL_GROUPS, logics: LOGIC_OPTIONS },
      });
    }

    // 두바이부르노 정본 회차 TP 복구 (평탄화된 levels 오버라이드 제거)
    await healDubaiBrunoOverride(account.id);

    let bots = await prisma.symbolBot.findMany({
      where: { accountId: account.id },
      orderBy: [{ symbol: "asc" }, { direction: "asc" }],
    });

    // Migrate removed/unknown logics → dubai_bruno_313
    const outdated = bots.filter((b) => !isLogicId(b.logic));
    if (outdated.length > 0) {
      for (const b of outdated) {
        const nextLogic = normalizeLogicId(b.logic);
        const logic = isLogicId(nextLogic) ? nextLogic : "dubai_bruno_313";
        await prisma.symbolBot.update({
          where: { id: b.id },
          data: {
            logic,
            ...(logic === "dubai_bruno_313"
              ? {
                  entryCount: DUBAI313_LEVEL_COUNT,
                  entryMultiplier: 1,
                  stopLossPct: 225,
                  stopLossEnabled: true,
                }
              : {}),
          },
        });
      }
      const legacyOverride = await prisma.strategyLogic.findUnique({
        where: { accountId_logicId: { accountId: account.id, logicId: "dca_1000" } },
      });
      if (legacyOverride) {
        const dubaiExists = await prisma.strategyLogic.findUnique({
          where: {
            accountId_logicId: { accountId: account.id, logicId: "dubai_bruno_313" },
          },
        });
        if (dubaiExists) {
          await prisma.strategyLogic.delete({ where: { id: legacyOverride.id } });
        } else {
          await prisma.strategyLogic.update({
            where: { id: legacyOverride.id },
            data: { logicId: "dubai_bruno_313" },
          });
        }
      }
      bots = await prisma.symbolBot.findMany({
        where: { accountId: account.id },
        orderBy: [{ symbol: "asc" }, { direction: "asc" }],
      });
    }

    // 예전 가격% 저장값 → ROI% (1%가격 = 20 ROI). 손절 <10 도 구 차트%/오류값으로 간주
    const needRoiMigrate = bots.filter(
      (b) =>
        (b.takeProfitPct > 0 && b.takeProfitPct <= 5) ||
        (b.stopLossPct > 0 && b.stopLossPct < 10),
    );
    if (needRoiMigrate.length > 0) {
      for (const b of needRoiMigrate) {
        const tp =
          b.takeProfitPct > 0 && b.takeProfitPct <= 5
            ? Math.round(b.takeProfitPct * 20 * 100) / 100
            : b.takeProfitPct;
        const sl =
          b.stopLossPct > 0 && b.stopLossPct < 10
            ? Math.max(225, Math.round(b.stopLossPct * 20 * 100) / 100)
            : b.stopLossPct > 0
              ? b.stopLossPct
              : 225;
        await prisma.symbolBot.update({
          where: { id: b.id },
          data: { takeProfitPct: tp, stopLossPct: sl, stopLossEnabled: sl > 0 },
        });
      }
      bots = await prisma.symbolBot.findMany({
        where: { accountId: account.id },
        orderBy: [{ symbol: "asc" }, { direction: "asc" }],
      });
    }

    // 라이브 스케일: L0 미리보기$ = pct 파생 (익절·손절 모두 마진×ROI%, 바이낸스식).
    const needUsdMigrate = bots.filter((b) => {
      const m = resolveTpSlUsd({
        symbol: b.symbol,
        startLots: b.startLots,
        takeProfitPct: b.takeProfitPct > 0 ? b.takeProfitPct : 20,
        stopLossPct: b.stopLossPct >= 10 ? b.stopLossPct : 225,
      });
      if (!(b.takeProfitUsd > 0) || !(b.stopLossUsd > 0)) return true;
      return b.stopLossUsd > m.stopLossUsd * 2;
    });
    if (needUsdMigrate.length > 0) {
      for (const b of needUsdMigrate) {
        const slPct = b.stopLossPct >= 10 ? b.stopLossPct : 225;
        const usd = resolveTpSlUsd({
          symbol: b.symbol,
          startLots: b.startLots,
          takeProfitPct: b.takeProfitPct > 0 ? b.takeProfitPct : 20,
          stopLossPct: slPct,
        });
        await prisma.symbolBot.update({
          where: { id: b.id },
          data: {
            takeProfitUsd: usd.takeProfitUsd,
            stopLossUsd: usd.stopLossUsd,
            stopLossPct: slPct,
            stopLossEnabled: true,
          },
        });
      }
      bots = await prisma.symbolBot.findMany({
        where: { accountId: account.id },
        orderBy: [{ symbol: "asc" }, { direction: "asc" }],
      });
    }

    if (bots.length === 0) {
      const eur = resolveTpSlUsd({
        symbol: "EURUSD",
        startLots: 0.01,
        takeProfitPct: 20,
        stopLossPct: 225,
      });
      const xau = resolveTpSlUsd({
        symbol: "XAUUSD",
        startLots: 0.01,
        takeProfitPct: 20,
        stopLossPct: 225,
      });
      await prisma.symbolBot.createMany({
        data: [
          {
            accountId: account.id,
            symbol: "EURUSD",
            enabled: true,
            logic: "dubai_bruno_313",
            entryCount: DUBAI313_LEVEL_COUNT,
            entryMultiplier: 1,
            takeProfitPct: 20,
            takeProfitUsd: eur.takeProfitUsd,
            stopLossPct: 225,
            stopLossUsd: eur.stopLossUsd,
            stopLossEnabled: true,
            stopOnSl: true,
            repeatEnabled: true,
          },
          {
            accountId: account.id,
            symbol: "XAUUSD",
            enabled: false,
            logic: "dubai_bruno_313",
            entryCount: DUBAI313_LEVEL_COUNT,
            entryMultiplier: 1,
            takeProfitPct: 20,
            takeProfitUsd: xau.takeProfitUsd,
            stopLossPct: 225,
            stopLossUsd: xau.stopLossUsd,
            stopLossEnabled: true,
            stopOnSl: true,
            repeatEnabled: true,
          },
        ],
      });
      bots = await prisma.symbolBot.findMany({
        where: { accountId: account.id },
        orderBy: [{ symbol: "asc" }, { direction: "asc" }],
      });
    }

    // dubai entryCount가 정본과 다르면 교정
    let fixedCount = false;
    for (const b of bots) {
      if (b.logic === "dubai_bruno_313" && b.entryCount !== DUBAI313_LEVEL_COUNT) {
        await prisma.symbolBot.update({
          where: { id: b.id },
          data: { entryCount: DUBAI313_LEVEL_COUNT, entryMultiplier: 1 },
        });
        fixedCount = true;
      }
    }
    if (fixedCount) {
      bots = await prisma.symbolBot.findMany({
        where: { accountId: account.id },
        orderBy: [{ symbol: "asc" }, { direction: "asc" }],
      });
    }

    return NextResponse.json({
      bots,
      options: { symbols: SYMBOL_OPTIONS, groups: SYMBOL_GROUPS, logics: LOGIC_OPTIONS },
      logicLevels: Object.fromEntries(
        await Promise.all(
          [...new Set(bots.map((b) => b.logic))].map(async (logic) => {
            const resolved = await resolveStrategyForAccount(account.id, logic, {
              startLots: bots.find((b) => b.logic === logic)?.startLots ?? 0.01,
              entryMultiplier:
                bots.find((b) => b.logic === logic)?.entryMultiplier ??
                defaultEntryMultiplier(logic),
            });
            return [logic, resolved.levels] as const;
          }),
        ),
      ),
    });
  } catch (err) {
    console.error("[symbol-bots GET]", err);
    return NextResponse.json(
      { error: toKoreanError(err, "종목 목록을 불러오지 못했습니다.") },
      { status: 500 },
    );
  }
}

const upsertSchema = z.object({
  symbol: z.string().min(3).max(20),
  enabled: z.boolean().optional(),
  logic: z.enum(LOGIC_IDS).optional(),
  direction: z.enum(["BUY", "SELL"]).optional(),
  entryCount: z.number().int().min(1).max(2000).optional(),
  entryMultiplier: z.number().positive().max(10).optional(),
  entryIntervalPct: z.number().positive().max(50).optional(),
  takeProfitPct: z.number().min(1).max(500).optional(),
  takeProfitUsd: z.number().min(0).max(1_000_000).optional(),
  startLots: z.number().positive().max(100).optional(),
  repeatEnabled: z.boolean().optional(),
  stopLossPct: z.number().min(0).max(1000).optional(),
  stopLossUsd: z.number().min(0).max(1_000_000).optional(),
  stopLossEnabled: z.boolean().optional(),
  stopOnSl: z.boolean().optional(),
});

function zodErrorKo(err: z.ZodError) {
  const first = err.issues[0];
  if (!first) return "입력값이 올바르지 않습니다.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function PUT(req: Request) {
  try {
    const gate = await requireApprovedUser();
    if (!gate.user) {
      return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
    }
    const account = await getAccount(gate.user.id);
    if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

    const rawBody = await req.json().catch(() => null);
    const parsed = upsertSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: zodErrorKo(parsed.error) }, { status: 400 });
    }
    const body = parsed.data;
    const symbol = normalizeSymbol(body.symbol);
    if (!symbol || symbol.length < 3) {
      return NextResponse.json({ error: "종목 심볼이 올바르지 않습니다." }, { status: 400 });
    }
    if (!SYMBOL_SET.has(symbol)) {
      return NextResponse.json(
        { error: `${symbol}은(는) 지원하지 않는 종목입니다.` },
        { status: 400 },
      );
    }

    const logic = body.logic && isLogicId(body.logic) ? body.logic : undefined;
    const resolvedLogic = logic ?? "dubai_bruno_313";
    const meta = tableLogicMeta(resolvedLogic);
    const levels = getTableLevels(resolvedLogic);
    const defaultMult = defaultEntryMultiplier(resolvedLogic);

    const createLots = body.startLots ?? 0.01;
    const createTpPct = body.takeProfitPct ?? meta.firstTpRoi ?? 20;
    const createSlPct = body.stopLossPct ?? 225;
    const createUsd = resolveTpSlUsd({
      symbol,
      startLots: createLots,
      takeProfitUsd:
        body.takeProfitUsd != null && body.takeProfitUsd >= 0.01
          ? body.takeProfitUsd
          : undefined,
      stopLossUsd:
        body.stopLossUsd != null && body.stopLossUsd > 0 ? body.stopLossUsd : undefined,
      takeProfitPct: createTpPct,
      stopLossPct: createSlPct,
    });

    const tpUsd =
      body.takeProfitUsd != null && body.takeProfitUsd >= 0.01
        ? Math.round(body.takeProfitUsd * 100) / 100
        : createUsd.takeProfitUsd;
    const slUsd =
      body.stopLossUsd != null && body.stopLossUsd > 0
        ? Math.round(body.stopLossUsd * 100) / 100
        : createUsd.stopLossUsd;

    const bot = await prisma.symbolBot.upsert({
      where: {
        accountId_symbol: { accountId: account.id, symbol },
      },
      create: {
        accountId: account.id,
        symbol,
        enabled: body.enabled ?? true,
        logic: resolvedLogic,
        direction: body.direction ?? "BUY",
        entryCount: body.entryCount ?? meta.count,
        entryMultiplier: body.entryMultiplier ?? defaultMult,
        entryIntervalPct: body.entryIntervalPct ?? 5,
        takeProfitPct: createTpPct,
        takeProfitUsd: tpUsd,
        startLots: createLots,
        repeatEnabled: body.repeatEnabled ?? true,
        stopLossPct: createSlPct,
        stopLossUsd: slUsd,
        stopLossEnabled: body.stopLossEnabled ?? true,
        stopOnSl: body.stopOnSl ?? true,
      },
      update: {
        ...(logic
          ? {
              logic,
              entryCount: body.entryCount ?? levels.length,
              ...(body.entryMultiplier == null && isMartinLogic(logic)
                ? { entryMultiplier: 2 }
                : {}),
            }
          : {}),
        ...(body.enabled != null ? { enabled: body.enabled } : {}),
        ...(body.direction ? { direction: body.direction } : {}),
        ...(body.entryCount != null ? { entryCount: body.entryCount } : {}),
        ...(body.entryMultiplier != null ? { entryMultiplier: body.entryMultiplier } : {}),
        ...(body.entryIntervalPct != null ? { entryIntervalPct: body.entryIntervalPct } : {}),
        ...(body.takeProfitPct != null ? { takeProfitPct: body.takeProfitPct } : {}),
        ...(body.takeProfitUsd != null && body.takeProfitUsd >= 0.01
          ? { takeProfitUsd: tpUsd }
          : body.startLots != null || body.takeProfitPct != null
            ? { takeProfitUsd: tpUsd }
            : {}),
        ...(body.startLots != null ? { startLots: body.startLots } : {}),
        ...(body.repeatEnabled != null ? { repeatEnabled: body.repeatEnabled } : {}),
        ...(body.stopLossPct != null ? { stopLossPct: body.stopLossPct } : {}),
        ...(body.stopLossUsd != null
          ? { stopLossUsd: slUsd }
          : body.startLots != null || body.stopLossPct != null
            ? { stopLossUsd: slUsd }
            : {}),
        ...(body.stopLossEnabled != null ? { stopLossEnabled: body.stopLossEnabled } : {}),
        ...(body.stopOnSl != null ? { stopOnSl: body.stopOnSl } : {}),
      },
    });

    if (
      (body.startLots != null || body.takeProfitPct != null || body.stopLossPct != null) &&
      (body.takeProfitUsd == null || body.takeProfitUsd < 0.01) &&
      (body.stopLossUsd == null || body.stopLossUsd <= 0)
    ) {
      const usd = resolveTpSlUsd({
        symbol: bot.symbol,
        startLots: bot.startLots,
        takeProfitPct: bot.takeProfitPct,
        stopLossPct: bot.stopLossPct > 0 ? bot.stopLossPct : 225,
      });
      await prisma.symbolBot.update({
        where: { id: bot.id },
        data: { takeProfitUsd: usd.takeProfitUsd, stopLossUsd: usd.stopLossUsd },
      });
      bot.takeProfitUsd = usd.takeProfitUsd;
      bot.stopLossUsd = usd.stopLossUsd;
    }

    // StrategyLogic 동기화 — 두바이부르노는 회차 TP 정본 유지 (takeProfitPct/levels 금지)
    const logicId = bot.logic;
    const existing = await prisma.strategyLogic.findUnique({
      where: { accountId_logicId: { accountId: account.id, logicId } },
    });
    if (existing) {
      const prev = (existing.payload || {}) as Record<string, unknown>;
      if (isBulkLogic(logicId)) {
        const nextPayload: Record<string, unknown> = {
          mode: "bulk",
          leverageBase: prev.leverageBase ?? 20,
          startLots: body.startLots != null ? bot.startLots : (prev.startLots ?? bot.startLots),
          stopLossPct:
            body.stopLossPct != null ? bot.stopLossPct : (prev.stopLossPct ?? bot.stopLossPct),
          ...(body.stopLossUsd != null || body.startLots != null
            ? { stopLossUsd: bot.stopLossUsd }
            : prev.stopLossUsd != null
              ? { stopLossUsd: prev.stopLossUsd }
              : {}),
          ...(body.takeProfitUsd != null || body.startLots != null
            ? { takeProfitUsd: bot.takeProfitUsd }
            : prev.takeProfitUsd != null
              ? { takeProfitUsd: prev.takeProfitUsd }
              : {}),
        };
        await prisma.strategyLogic.update({
          where: { id: existing.id },
          data: { payload: nextPayload as Prisma.InputJsonValue },
        });
      } else {
        const nextPayload: Record<string, unknown> = {
          ...prev,
          mode: (prev.mode as "bulk" | "levels") || (isMartinLogic(logicId) ? "levels" : "bulk"),
          ...(body.startLots != null ? { startLots: bot.startLots } : {}),
          ...(body.takeProfitPct != null ? { takeProfitPct: bot.takeProfitPct } : {}),
          ...(body.stopLossPct != null ? { stopLossPct: bot.stopLossPct } : {}),
          ...(body.takeProfitUsd != null || body.startLots != null
            ? { takeProfitUsd: bot.takeProfitUsd }
            : {}),
          ...(body.stopLossUsd != null || body.startLots != null
            ? { stopLossUsd: bot.stopLossUsd }
            : {}),
        };
        if (Array.isArray(prev.levels) && body.startLots != null) {
          const rows = prev.levels as Array<{ lots: number; profit: number; drop: number }>;
          if (rows.length > 0) {
            const ratio = bot.startLots / Math.max(0.01, rows[0].lots || 0.01);
            nextPayload.levels = rows.map((r, i) => ({
              ...r,
              lots: i === 0 ? bot.startLots : Math.max(0.01, Math.round(r.lots * ratio * 100) / 100),
            }));
          }
        }
        await prisma.strategyLogic.update({
          where: { id: existing.id },
          data: { payload: nextPayload as Prisma.InputJsonValue },
        });
      }
    }

    return NextResponse.json({ ok: true, bot });
  } catch (err) {
    console.error("[symbol-bots PUT]", err);
    return NextResponse.json(
      {
        error: toKoreanError(err, "종목 추가/저장에 실패했습니다. 잠시 후 다시 시도하세요."),
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const gate = await requireApprovedUser();
    if (!gate.user) {
      return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
    }
    const account = await getAccount(gate.user.id);
    if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const symbol = normalizeSymbol(searchParams.get("symbol") || "");
    if (!symbol) return NextResponse.json({ error: "symbol 필요" }, { status: 400 });
    await prisma.symbolBot.deleteMany({ where: { accountId: account.id, symbol } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[symbol-bots DELETE]", err);
    return NextResponse.json(
      { error: toKoreanError(err, "종목 삭제에 실패했습니다.") },
      { status: 500 },
    );
  }
}
