import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { isLogicId } from "@/lib/strategies";
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
  profit: z.number().min(0).max(500),
  drop: z.number().min(0).max(1000),
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
      takeProfitPct: z.number().min(0).max(500).optional(),
      stopLossPct: z.number().min(0).max(1000).optional(),
      levels: z.array(levelSchema).max(60).optional(),
    })
    .optional(),
});

export async function GET(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const logicId = new URL(req.url).searchParams.get("logic") || "martin_9";
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

  // levels 에디터용: 저장된 levels 없으면 resolved에서 생성
  let editorLevels = payload.levels;
  if ((!editorLevels || editorLevels.length === 0) && isLevelsEditableLogic(logicId)) {
    editorLevels = resolved.levels.map((lv, i) => ({
      lots: lv.lots ?? 0.01,
      profit: lv.profit,
      drop: i === 0 ? 0 : lv.drop,
    }));
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
      startLots: payload.startLots ?? resolved.startLots,
      takeProfitPct: payload.takeProfitPct ?? resolved.takeProfitPct ?? defaults.takeProfitPct,
      stopLossPct: payload.stopLossPct ?? resolved.stopLossPct ?? defaults.stopLossPct,
    },
    resolved: {
      levelCount: resolved.levels.length,
      startLots: resolved.startLots,
      takeProfitPct: resolved.takeProfitPct,
      stopLossPct: resolved.stopLossPct,
    },
  });
}

export async function PUT(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const body = putSchema.parse(await req.json());
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
  };

  if (mode === "levels") {
    const levels = body.payload.levels || [];
    if (levels.length < 1) {
      return NextResponse.json({ error: "회차가 최소 1개 필요합니다." }, { status: 400 });
    }
    if (levels.length > 60) {
      return NextResponse.json({ error: "회차는 최대 60개입니다." }, { status: 400 });
    }
    payload.levels = levels.map((lv, i) => ({
      lots: Math.max(0.01, Math.round(lv.lots * 100) / 100),
      profit: lv.profit,
      drop: i === 0 ? 0 : lv.drop,
    }));
    payload.startLots = payload.levels[0].lots;
  }

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

  // 이 로직을 쓰는 종목봇에 시작로트·익절·손절 동기화
  const botPatch: {
    startLots?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    stopLossEnabled?: boolean;
    entryCount?: number;
  } = {};
  if (payload.startLots != null) botPatch.startLots = payload.startLots;
  if (payload.takeProfitPct != null && payload.takeProfitPct > 0) {
    botPatch.takeProfitPct = payload.takeProfitPct;
  }
  if (payload.stopLossPct != null) {
    botPatch.stopLossPct = payload.stopLossPct;
    botPatch.stopLossEnabled = payload.stopLossPct > 0;
  }
  if (payload.levels?.length) botPatch.entryCount = payload.levels.length;

  if (Object.keys(botPatch).length > 0) {
    await prisma.symbolBot.updateMany({
      where: { accountId: account.id, logic: logicId },
      data: botPatch,
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
