import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser, requireAdmin } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { DCA1000_DEFAULT_SL_ROI, resolveTpSlUsd } from "@/lib/dca1000";
import { isLogicId } from "@/lib/strategies";
import { publicLogicLabel, isPresetLogicId } from "@/lib/strategy-public";
import {
  defaultEditorPayload,
  isBulkLogic,
  isLevelsEditableLogic,
  type StrategyPayload,
} from "@/lib/table-logics";
import { resolveStrategyForAccount } from "@/lib/strategy-resolve";

async function getAccount(userId: string) {
  return prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

const levelSchema = z.object({
  lots: z.number().positive().max(100),
  profit: z.number().min(1).max(500),
  drop: z.number().min(0).max(5000),
});

const putSchema = z.object({
  logicId: z.string().min(2).max(40),
  name: z.string().max(80).optional(),
  reset: z.boolean().optional(),
  payload: z
    .object({
      mode: z.enum(["bulk", "levels"]),
      leverageBase: z.number().positive().max(100).optional(),
      startLots: z.number().positive().max(100).optional(),
      takeProfitPct: z.number().min(1).max(500).optional(),
      stopLossPct: z.number().min(0).max(5000).optional(),
      takeProfitUsd: z.number().min(0.01).max(1_000_000).optional(),
      stopLossUsd: z.number().min(0).max(1_000_000).optional(),
      levels: z.array(levelSchema).max(60).optional(),
    })
    .optional(),
});

function zodErrorKo(err: z.ZodError) {
  const first = err.issues[0];
  if (!first) return "입력값이 올바르지 않습니다.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function GET(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const logicId = new URL(req.url).searchParams.get("logic") || "martin_9_65";
  if (!isLogicId(logicId) && logicId !== "custom") {
    return NextResponse.json({ error: "알 수 없는 로직입니다." }, { status: 400 });
  }

  const saved = await prisma.strategyLogic.findUnique({
    where: { accountId_logicId: { accountId: account.id, logicId } },
  });

  const resolved = await resolveStrategyForAccount(account.id, logicId, {
    startLots: 0.01,
    entryMultiplier: 2,
  });

  const defaults = defaultEditorPayload(logicId);
  const payload = (saved?.payload as StrategyPayload | null) || defaults;
  const startLots = payload.startLots ?? resolved.startLots ?? 0.01;
  const tpPct = payload.takeProfitPct ?? resolved.takeProfitPct ?? defaults.takeProfitPct ?? 20;
  const slPct = payload.stopLossPct ?? resolved.stopLossPct ?? defaults.stopLossPct ?? DCA1000_DEFAULT_SL_ROI;
  const usd = resolveTpSlUsd({
    symbol: "XAUUSD",
    startLots,
    takeProfitUsd: payload.takeProfitUsd ?? resolved.takeProfitUsd,
    stopLossUsd: payload.stopLossUsd ?? resolved.stopLossUsd,
    takeProfitPct: tpPct,
    stopLossPct: slPct,
  });

  // levels 에디터용: 저장된 levels 없으면 resolved에서 생성
  let editorLevels = payload.levels;
  if ((!editorLevels || editorLevels.length === 0) && isLevelsEditableLogic(logicId)) {
    editorLevels = resolved.levels.map((lv, i) => ({
      lots: lv.lots ?? 0.01,
      profit: lv.profit,
      drop: i === 0 ? 0 : lv.drop,
    }));
  }

  const admin = await requireAdmin();
  const isAdmin = !!admin.user;

  // End users: public summary only — no levels / ROI% / drop / TP-SL $
  if (!isAdmin) {
    return NextResponse.json({
      logicId,
      name: publicLogicLabel(logicId),
      hasOverride: !!saved,
      locked: isPresetLogicId(logicId),
      summary: { locked: true },
      payload: { mode: "bulk" },
      resolved: { locked: true },
    });
  }

  return NextResponse.json({
    logicId,
    name: saved?.name || null,
    hasOverride: !!saved,
    editable: isLevelsEditableLogic(logicId) ? "levels" : "bulk",
    payload: {
      ...payload,
      mode: isBulkLogic(logicId) ? "bulk" : "levels",
      levels: editorLevels,
      startLots,
      takeProfitPct: tpPct,
      stopLossPct: slPct,
      takeProfitUsd: usd.takeProfitUsd,
      stopLossUsd: usd.stopLossUsd,
    },
    resolved: {
      levelCount: resolved.levels.length,
      startLots: resolved.startLots,
      takeProfitPct: resolved.takeProfitPct,
      stopLossPct: resolved.stopLossPct,
      takeProfitUsd: usd.takeProfitUsd,
      stopLossUsd: usd.stopLossUsd,
    },
  });
}

export async function PUT(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  // Strategy table editing is admin-only (IP protection)
  if (gate.user.role !== "admin") {
    return NextResponse.json(
      { error: "전략 세부 파라미터는 변경할 수 없습니다." },
      { status: 403 },
    );
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: zodErrorKo(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;
  const logicId = body.logicId;
  if (!isLogicId(logicId)) {
    return NextResponse.json({ error: "알 수 없는 로직입니다." }, { status: 400 });
  }

  if (body.reset) {
    await prisma.strategyLogic.deleteMany({
      where: { accountId: account.id, logicId },
    });
    return NextResponse.json({ ok: true, reset: true });
  }

  if (!body.payload) {
    return NextResponse.json({ error: "payload 필요" }, { status: 400 });
  }

  const mode = isBulkLogic(logicId) ? "bulk" : "levels";
  let payload: StrategyPayload = {
    mode,
    leverageBase: body.payload.leverageBase ?? 20,
    startLots: body.payload.startLots ?? 0.01,
    takeProfitPct: body.payload.takeProfitPct,
    stopLossPct: body.payload.stopLossPct,
    takeProfitUsd: body.payload.takeProfitUsd,
    stopLossUsd: body.payload.stopLossUsd,
  };

  if (mode === "levels") {
    const levels = body.payload.levels || [];
    if (levels.length < 1) {
      return NextResponse.json({ error: "회차가 최소 1개 필요합니다." }, { status: 400 });
    }
    if (levels.length > 60) {
      return NextResponse.json({ error: "회차는 최대 60개입니다." }, { status: 400 });
    }
    const tp =
      body.payload.takeProfitPct != null && body.payload.takeProfitPct >= 1
        ? body.payload.takeProfitPct
        : levels[0]?.profit ?? 20;
    payload.takeProfitPct = tp;
    payload.levels = levels.map((lv, i) => ({
      lots: Math.max(0.01, Math.round(lv.lots * 100) / 100),
      // 엔진 바스켓 익절은 단일 $ — 회차별 profit(레거시)도 동일 값으로 맞춤
      profit: tp,
      drop: i === 0 ? 0 : lv.drop,
    }));
    payload.startLots = payload.levels[0].lots;
  }

  const usdResolved = resolveTpSlUsd({
    symbol: "XAUUSD",
    startLots: payload.startLots ?? 0.01,
    takeProfitUsd: payload.takeProfitUsd,
    stopLossUsd: payload.stopLossUsd,
    takeProfitPct: payload.takeProfitPct ?? 20,
    stopLossPct: payload.stopLossPct ?? DCA1000_DEFAULT_SL_ROI,
  });
  payload.takeProfitUsd = usdResolved.takeProfitUsd;
  payload.stopLossUsd = usdResolved.stopLossUsd;
  payload.takeProfitPct = usdResolved.takeProfitPct;
  payload.stopLossPct = usdResolved.stopLossPct;

  const row = await prisma.strategyLogic.upsert({
    where: { accountId_logicId: { accountId: account.id, logicId } },
    create: {
      accountId: account.id,
      logicId,
      name: body.name || null,
      payload,
    },
    update: {
      name: body.name ?? undefined,
      payload,
    },
  });

  // 이 로직을 쓰는 종목봇에 시작로트·익절$·손절$ 동기화 (심볼별 $는 봇 심볼로 재계산)
  const botsUsing = await prisma.symbolBot.findMany({
    where: { accountId: account.id, logic: logicId },
  });
  for (const b of botsUsing) {
    const perSym = resolveTpSlUsd({
      symbol: b.symbol,
      startLots: payload.startLots ?? b.startLots,
      takeProfitUsd:
        body.payload.takeProfitUsd != null ? payload.takeProfitUsd : undefined,
      stopLossUsd: body.payload.stopLossUsd != null ? payload.stopLossUsd : undefined,
      takeProfitPct: payload.takeProfitPct,
      stopLossPct: payload.stopLossPct,
    });
    await prisma.symbolBot.update({
      where: { id: b.id },
      data: {
        startLots: payload.startLots ?? b.startLots,
        takeProfitPct: perSym.takeProfitPct,
        stopLossPct: perSym.stopLossPct,
        takeProfitUsd: perSym.takeProfitUsd,
        stopLossUsd: perSym.stopLossUsd,
        stopLossEnabled: (payload.stopLossPct ?? 0) > 0 || perSym.stopLossUsd > 0,
        ...(payload.levels?.length ? { entryCount: payload.levels.length } : {}),
      },
    });
  }

  return NextResponse.json({ ok: true, logic: row });
}

export async function DELETE(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });
  const logicId = new URL(req.url).searchParams.get("logic");
  if (!logicId) return NextResponse.json({ error: "logic 필요" }, { status: 400 });
  await prisma.strategyLogic.deleteMany({
    where: { accountId: account.id, logicId },
  });
  return NextResponse.json({ ok: true });
}
