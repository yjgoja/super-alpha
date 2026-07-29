import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser, requireUser, requireAdmin } from "@/lib/access";
import { ensureTradingSchema, prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { DCA1000_DEFAULT_SL_ROI, resolveTpSlUsd } from "@/lib/dca1000";
import {
  SYMBOL_GROUPS,
  SYMBOL_OPTIONS,
  isLogicId,
  logicBotDefaults,
  normalizeLogicId,
} from "@/lib/strategies";
import { publicLogicOptions, redactSymbolBot } from "@/lib/strategy-public";
import {
  defaultEditorPayload,
  defaultEntryMultiplier,
  getTableLevels,
  isMartinLogic,
  resolveLiveStopLossPct,
  tableLogicMeta,
} from "@/lib/table-logics";
import { withAccountToggleLock } from "@/lib/toggle-lock";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const maxDuration = 30;

/** 알파 지속 전체 회차(L0 포함) — 표에서 파생 (하드코딩 금지) */
const DUBAI313_LEVEL_COUNT = tableLogicMeta("dubai_bruno_313").count;

async function getAccount(userId: string) {
  // Explicit select so a pending Prisma column migration cannot 500 this route
  return prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      login: true,
      status: true,
      metaApiAccountId: true,
      botEnabled: true,
    },
  });
}

/**
 * Fast read path — never run multi-pass per-bot migrations here.
 * Those loops timed out on Vercel and left Bot page stuck on "불러오는 중…".
 */
export async function GET() {
  await ensureTradingSchema();
  const gate = await requireUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) {
    return NextResponse.json({
      bots: [],
      options: {
        symbols: SYMBOL_OPTIONS,
        groups: SYMBOL_GROUPS,
        logics: publicLogicOptions(),
      },
    });
  }

  let bots = await prisma.symbolBot.findMany({
    where: { accountId: account.id },
    orderBy: [{ symbol: "asc" }, { direction: "asc" }],
  });

  if (bots.length === 0) {
    const sustainedSl = resolveLiveStopLossPct("dubai_bruno_313");
    const eur = resolveTpSlUsd({
      symbol: "EURUSD",
      startLots: 0.01,
      takeProfitPct: 20,
      stopLossPct: sustainedSl,
    });
    const xau = resolveTpSlUsd({
      symbol: "XAUUSD",
      startLots: 0.01,
      takeProfitPct: 20,
      stopLossPct: sustainedSl,
    });
    const base = (symbol: string, usd: typeof eur, enabled: boolean, direction: "BUY" | "SELL") => ({
      accountId: account.id,
      symbol,
      direction,
      enabled,
      logic: "dubai_bruno_313",
      entryCount: DUBAI313_LEVEL_COUNT,
      entryMultiplier: 1,
      takeProfitPct: 20,
      takeProfitUsd: usd.takeProfitUsd,
      stopLossPct: sustainedSl,
      stopLossUsd: usd.stopLossUsd,
      stopLossEnabled: true,
      stopOnSl: true,
      repeatEnabled: true,
    });
    await prisma.symbolBot.createMany({
      data: [
        base("EURUSD", eur, true, "BUY"),
        base("EURUSD", eur, true, "SELL"),
        base("XAUUSD", xau, false, "BUY"),
        base("XAUUSD", xau, false, "SELL"),
      ],
    });
    bots = await prisma.symbolBot.findMany({
      where: { accountId: account.id },
      orderBy: [{ symbol: "asc" }, { direction: "asc" }],
    });
  }

  const admin = await requireAdmin();
  const isAdmin = !!admin.user;

  // Fast list payload only — never resolve full DCA tables here (timed out for admin).
  return NextResponse.json({
    bots: isAdmin ? bots : bots.map((b) => redactSymbolBot(b as unknown as Record<string, unknown>)),
    options: {
      symbols: SYMBOL_OPTIONS,
      groups: SYMBOL_GROUPS,
      logics: publicLogicOptions(),
    },
  });
}

const upsertSchema = z.object({
  symbol: z.string().min(3).max(20),
  enabled: z.boolean().optional(),
  logic: z
    .string()
    .optional()
    .transform((v) => (v ? normalizeLogicId(v) : v))
    .refine((v) => v == null || isLogicId(v), "알 수 없는 로직"),
  direction: z.enum(["BUY", "SELL"]).optional(),
  entryCount: z.number().int().min(1).max(2000).optional(),
  entryMultiplier: z.number().positive().max(10).optional(),
  entryIntervalPct: z.number().positive().max(50).optional(),
  takeProfitPct: z.number().min(1).max(500).optional(),
  takeProfitUsd: z.number().min(0.01).max(1_000_000).optional(),
  startLots: z.number().positive().max(100).optional(),
  repeatEnabled: z.boolean().optional(),
  stopLossPct: z.number().min(0).max(5000).optional(),
  dualDirection: z.boolean().optional(),
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
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const parsed = upsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: zodErrorKo(parsed.error) }, { status: 400 });
  }

  return withAccountToggleLock(account.id, async () => {
    const body = parsed.data;
    const admin = await requireAdmin();
    const isAdmin = !!admin.user;

    // End users may only set preset / lots / toggles — never ROI%, ladder, TP/SL $
    if (!isAdmin) {
      delete body.takeProfitPct;
      delete body.stopLossPct;
      delete body.takeProfitUsd;
      delete body.stopLossUsd;
      delete body.entryIntervalPct;
      delete body.entryMultiplier;
      delete body.entryCount;
    }

    const direction = body.direction ?? "BUY";
    // Open basket: freeze mid-cycle risk params (logic / lots / TP·SL / ladder).
    // Toggles (enabled / repeat / stopOnSl / dualDirection) remain allowed.
    const openBaskets = await prisma.basket.count({
      where: {
        accountId: account.id,
        symbol: body.symbol,
        direction,
        status: "open",
      },
    });
    let openBasketFrozen = false;
    if (openBaskets > 0) {
      const riskTouch =
        (body.logic != null && isLogicId(body.logic)) ||
        body.startLots != null ||
        body.takeProfitPct != null ||
        body.takeProfitUsd != null ||
        body.stopLossPct != null ||
        body.stopLossUsd != null ||
        body.stopLossEnabled != null ||
        body.entryMultiplier != null ||
        body.entryIntervalPct != null ||
        body.entryCount != null;
      if (riskTouch) {
        openBasketFrozen = true;
        delete body.logic;
        delete body.startLots;
        delete body.takeProfitPct;
        delete body.takeProfitUsd;
        delete body.stopLossPct;
        delete body.stopLossUsd;
        delete body.stopLossEnabled;
        delete body.entryMultiplier;
        delete body.entryIntervalPct;
        delete body.entryCount;
      }
    }

    const logic =
      body.logic && isLogicId(body.logic) ? body.logic : undefined;
    const resolvedLogic = logic ?? "dubai_bruno_313";
    const namedDefaults = logicBotDefaults(resolvedLogic);
    const meta = tableLogicMeta(resolvedLogic);
    const levels = getTableLevels(
      resolvedLogic,
      body.entryMultiplier ?? namedDefaults?.entryMultiplier ?? defaultEntryMultiplier(resolvedLogic),
    );
    const defaultMult =
      namedDefaults?.entryMultiplier ?? defaultEntryMultiplier(resolvedLogic);
    const editorDefaults = defaultEditorPayload(resolvedLogic);
    const defaultEntryCount =
      namedDefaults?.entryCount ?? meta.count ?? levels.length;

    const createLots =
      body.startLots ?? namedDefaults?.startLots ?? editorDefaults.startLots ?? 0.01;
    const createTpPct =
      body.takeProfitPct ?? editorDefaults.takeProfitPct ?? meta.firstTpRoi ?? 20;
    const createSlPct =
      body.stopLossPct ?? editorDefaults.stopLossPct ?? DCA1000_DEFAULT_SL_ROI;
    const createUsd = resolveTpSlUsd({
      symbol: body.symbol,
      startLots: createLots,
      takeProfitUsd: body.takeProfitUsd,
      stopLossUsd: body.stopLossUsd,
      takeProfitPct: createTpPct,
      stopLossPct: createSlPct,
    });

    let bot = await prisma.symbolBot.upsert({
      where: {
        accountId_symbol_direction: {
          accountId: account.id,
          symbol: body.symbol,
          direction,
        },
      },
      create: {
        accountId: account.id,
        symbol: body.symbol,
        enabled: body.enabled ?? true,
        logic: resolvedLogic,
        direction,
        dualDirection: body.dualDirection ?? false,
        entryCount: body.entryCount ?? defaultEntryCount,
        entryMultiplier: body.entryMultiplier ?? defaultMult,
        entryIntervalPct: body.entryIntervalPct ?? 5,
        takeProfitPct: createTpPct,
        takeProfitUsd: createUsd.takeProfitUsd,
        startLots: createLots,
        repeatEnabled: body.repeatEnabled ?? true,
        stopLossPct: createSlPct,
        stopLossUsd: createUsd.stopLossUsd,
        stopLossEnabled: body.stopLossEnabled ?? true,
        stopOnSl: body.stopOnSl ?? true,
      },
      update: {
        ...(logic
          ? {
              logic,
              entryCount: body.entryCount ?? defaultEntryCount,
              // 마틴으로 바꿀 때 배수 미지정이면 로직 기본 배수
              ...(body.entryMultiplier == null && isMartinLogic(logic)
                ? { entryMultiplier: defaultMult }
                : {}),
              // 프리셋 변경 시 사용자 요청 ROI/$ 무시하고 표·발굴 기본값 적용
              ...(!isAdmin
                ? {
                    entryMultiplier: defaultMult,
                    entryCount: defaultEntryCount,
                    startLots: namedDefaults?.startLots ?? createLots,
                    takeProfitPct: createTpPct,
                    stopLossPct: createSlPct,
                    takeProfitUsd: createUsd.takeProfitUsd,
                    stopLossUsd: createUsd.stopLossUsd,
                    stopLossEnabled: true,
                  }
                : {}),
            }
          : {}),
        ...(body.enabled != null ? { enabled: body.enabled } : {}),
        ...(body.direction ? { direction: body.direction } : {}),
        ...(body.dualDirection != null ? { dualDirection: body.dualDirection } : {}),
        ...(body.entryMultiplier != null ? { entryMultiplier: body.entryMultiplier } : {}),
        ...(body.entryIntervalPct != null ? { entryIntervalPct: body.entryIntervalPct } : {}),
        ...(body.takeProfitPct != null ? { takeProfitPct: body.takeProfitPct } : {}),
        ...(body.takeProfitUsd != null ? { takeProfitUsd: body.takeProfitUsd } : {}),
        ...(body.startLots != null ? { startLots: body.startLots } : {}),
        ...(body.repeatEnabled != null ? { repeatEnabled: body.repeatEnabled } : {}),
        ...(body.stopLossPct != null ? { stopLossPct: body.stopLossPct } : {}),
        ...(body.stopLossUsd != null ? { stopLossUsd: body.stopLossUsd } : {}),
        ...(body.stopLossEnabled != null ? { stopLossEnabled: body.stopLossEnabled } : {}),
        ...(body.stopOnSl != null ? { stopOnSl: body.stopOnSl } : {}),
      },
    });

    // startLots/ROI 변경 시 USD 미지정이면 재계산해 저장
    if (
      (body.startLots != null || body.takeProfitPct != null || body.stopLossPct != null || (!isAdmin && logic)) &&
      (body.takeProfitUsd == null || !isAdmin) &&
      (body.stopLossUsd == null || !isAdmin)
    ) {
      const usd = resolveTpSlUsd({
        symbol: bot.symbol,
        startLots: bot.startLots,
        takeProfitPct: bot.takeProfitPct,
        stopLossPct: bot.stopLossPct > 0 ? bot.stopLossPct : DCA1000_DEFAULT_SL_ROI,
      });
      bot = await prisma.symbolBot.update({
        where: { id: bot.id },
        data: { takeProfitUsd: usd.takeProfitUsd, stopLossUsd: usd.stopLossUsd },
      });
    }

    // Keep StrategyLogic override in sync so engine lots/TP/SL match /bot edits
    const logicId = bot.logic;
    const existing = await prisma.strategyLogic.findUnique({
      where: { accountId_logicId: { accountId: account.id, logicId } },
    });
    if (existing) {
      const prev = (existing.payload || {}) as Record<string, unknown>;
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

    let openBasketHint: string | undefined;
    if (openBasketFrozen) {
      openBasketHint =
        "열린 바스켓이 있어 로직·로트·TP/SL·물타기 설정 변경을 보류했습니다. 토글만 반영됩니다.";
    } else if (body.enabled === false && openBaskets > 0) {
      openBasketHint = "열린 포지션은 익절·손절만 계속 관리합니다 (신규·물타기 중지).";
    }

    return NextResponse.json({
      ok: true,
      bot: isAdmin
        ? bot
        : redactSymbolBot(bot as unknown as Record<string, unknown>),
      ...(openBasketHint ? { note: openBasketHint } : {}),
      ...(openBasketFrozen ? { frozen: true } : {}),
    });
  });
}

export async function DELETE(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const direction = searchParams.get("direction");
  if (!symbol) return NextResponse.json({ error: "symbol 필요" }, { status: 400 });
  await prisma.symbolBot.deleteMany({
    where: {
      accountId: account.id,
      symbol,
      ...(direction === "BUY" || direction === "SELL" ? { direction } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}
