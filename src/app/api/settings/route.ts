import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";

const schema = z.object({
  baseLots: z.number().positive().optional(),
  profitTarget: z.number().positive().optional(),
  maxDcaLevel: z.number().int().min(0).max(9).optional(),
  devScale: z.number().positive().optional(),
  finalSlExtraPct: z.number().min(0).optional(),
  enableFinalSl: z.boolean().optional(),
  reenterAfterTp: z.boolean().optional(),
  reenterAfterSl: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    include: { config: true },
    orderBy: { createdAt: "desc" },
  });
  if (!account?.config) {
    return NextResponse.json({ error: "계좌/설정 없음" }, { status: 400 });
  }

  const body = schema.parse(await req.json());
  const config = await prisma.strategyConfig.update({
    where: { id: account.config.id },
    data: body,
  });
  return NextResponse.json({ ok: true, config });
}

export async function POST() {
  // Resume after SL/TP pause
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const account = await prisma.brokerAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!account) return NextResponse.json({ error: "no account" }, { status: 400 });

  await prisma.basket.updateMany({
    where: { accountId: account.id, tradingPaused: true },
    data: { tradingPaused: false },
  });
  return NextResponse.json({ ok: true });
}
