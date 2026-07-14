import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { LOGIC_IDS, LOGIC_OPTIONS, SYMBOL_GROUPS, SYMBOL_OPTIONS, isLogicId } from "@/lib/strategies";
import {
  defaultEntryMultiplier,
  getTableLevels,
  isMartinLogic,
  tableLogicMeta,
} from "@/lib/table-logics";

async function getAccount(userId: string) {
  return prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function GET() {
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

  let bots = await prisma.symbolBot.findMany({
    where: { accountId: account.id },
    orderBy: { symbol: "asc" },
  });

  // Migrate unknown legacy logics → dca_1000
  const outdated = bots.filter((b) => !isLogicId(b.logic));
  if (outdated.length > 0) {
    await prisma.symbolBot.updateMany({
      where: {
        accountId: account.id,
        logic: { notIn: [...LOGIC_IDS] },
      },
      data: {
        logic: "dca_1000",
        entryCount: 999,
        entryMultiplier: 1,
        stopLossPct: 225,
        stopLossEnabled: true,
      },
    });
    bots = await prisma.symbolBot.findMany({
      where: { accountId: account.id },
      orderBy: { symbol: "asc" },
    });
  }

  // 예전 가격% 저장값(≤5) → ROI%로 마이그레이션 (1%가격 = 20 ROI)
  const needTpMigrate = bots.filter((b) => b.takeProfitPct > 0 && b.takeProfitPct <= 5);
  if (needTpMigrate.length > 0) {
    for (const b of needTpMigrate) {
      await prisma.symbolBot.update({
        where: { id: b.id },
        data: { takeProfitPct: Math.round(b.takeProfitPct * 20 * 100) / 100 },
      });
    }
    bots = await prisma.symbolBot.findMany({
      where: { accountId: account.id },
      orderBy: { symbol: "asc" },
    });
  }

  if (bots.length === 0) {
    await prisma.symbolBot.createMany({
      data: [
        {
          accountId: account.id,
          symbol: "EURUSD",
          enabled: true,
          logic: "dca_1000",
          entryCount: 999,
          entryMultiplier: 1,
          takeProfitPct: 20,
          stopLossPct: 225,
          stopLossEnabled: true,
          stopOnSl: true,
          repeatEnabled: true,
        },
        {
          accountId: account.id,
          symbol: "XAUUSD",
          enabled: false,
          logic: "dca_1000",
          entryCount: 999,
          entryMultiplier: 1,
          takeProfitPct: 20,
          stopLossPct: 225,
          stopLossEnabled: true,
          stopOnSl: true,
          repeatEnabled: true,
        },
      ],
    });
    bots = await prisma.symbolBot.findMany({
      where: { accountId: account.id },
      orderBy: { symbol: "asc" },
    });
  }

  return NextResponse.json({
    bots,
    options: { symbols: SYMBOL_OPTIONS, groups: SYMBOL_GROUPS, logics: LOGIC_OPTIONS },
  });
}

const upsertSchema = z.object({
  symbol: z.string().min(3).max(20),
  enabled: z.boolean().optional(),
  logic: z.enum(LOGIC_IDS).optional(),
  direction: z.enum(["BUY", "SELL"]).optional(),
  entryCount: z.number().int().min(1).max(2000).optional(),
  entryMultiplier: z.number().positive().max(10).optional(),
  entryIntervalPct: z.number().positive().max(50).optional(),
  takeProfitPct: z.number().positive().max(500).optional(),
  startLots: z.number().positive().max(100).optional(),
  repeatEnabled: z.boolean().optional(),
  stopLossPct: z.number().min(0).max(1000).optional(),
  stopLossEnabled: z.boolean().optional(),
  stopOnSl: z.boolean().optional(),
});

export async function PUT(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const account = await getAccount(gate.user.id);
  if (!account) return NextResponse.json({ error: "계좌가 없습니다." }, { status: 400 });

  const body = upsertSchema.parse(await req.json());
  const logic =
    body.logic && isLogicId(body.logic) ? body.logic : undefined;
  const resolvedLogic = logic ?? "dca_1000";
  const meta = tableLogicMeta(resolvedLogic);
  const levels = getTableLevels(resolvedLogic);
  const defaultMult = defaultEntryMultiplier(resolvedLogic);

  const bot = await prisma.symbolBot.upsert({
    where: {
      accountId_symbol: { accountId: account.id, symbol: body.symbol },
    },
    create: {
      accountId: account.id,
      symbol: body.symbol,
      enabled: body.enabled ?? true,
      logic: resolvedLogic,
      direction: body.direction ?? "BUY",
      entryCount: body.entryCount ?? meta.count,
      entryMultiplier: body.entryMultiplier ?? defaultMult,
      entryIntervalPct: body.entryIntervalPct ?? 5,
      takeProfitPct: body.takeProfitPct ?? meta.firstTpRoi ?? 20,
      startLots: body.startLots ?? 0.01,
      repeatEnabled: body.repeatEnabled ?? true,
      stopLossPct: body.stopLossPct ?? 225,
      stopLossEnabled: body.stopLossEnabled ?? true,
      stopOnSl: body.stopOnSl ?? true,
    },
    update: {
      ...(logic
        ? {
            logic,
            entryCount: body.entryCount ?? levels.length,
            // 마틴으로 바꿀 때 배수 미지정이면 기본 2배
            ...(body.entryMultiplier == null && isMartinLogic(logic)
              ? { entryMultiplier: 2 }
              : {}),
          }
        : {}),
      ...(body.enabled != null ? { enabled: body.enabled } : {}),
      ...(body.direction ? { direction: body.direction } : {}),
      ...(body.entryMultiplier != null ? { entryMultiplier: body.entryMultiplier } : {}),
      ...(body.entryIntervalPct != null ? { entryIntervalPct: body.entryIntervalPct } : {}),
      ...(body.takeProfitPct != null ? { takeProfitPct: body.takeProfitPct } : {}),
      ...(body.startLots != null ? { startLots: body.startLots } : {}),
      ...(body.repeatEnabled != null ? { repeatEnabled: body.repeatEnabled } : {}),
      ...(body.stopLossPct != null ? { stopLossPct: body.stopLossPct } : {}),
      ...(body.stopLossEnabled != null ? { stopLossEnabled: body.stopLossEnabled } : {}),
      ...(body.stopOnSl != null ? { stopOnSl: body.stopOnSl } : {}),
    },
  });

  return NextResponse.json({ ok: true, bot });
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
  if (!symbol) return NextResponse.json({ error: "symbol 필요" }, { status: 400 });
  await prisma.symbolBot.deleteMany({ where: { accountId: account.id, symbol } });
  return NextResponse.json({ ok: true });
}
