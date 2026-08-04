import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { resolveEditableBrokerAccount } from "@/lib/account-selection";
import { gateErrorKo } from "@/lib/ko-errors";

const schema = z.object({
  accountId: z.string().min(1).optional(),
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
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const body = schema.parse(await req.json());
  const { accountId: targetAccountId, ...patch } = body;
  const _active = await resolveEditableBrokerAccount({
    userId: gate.user.id,
    role: gate.user.role,
    accountId: targetAccountId,
  });
  const account = _active
    ? await prisma.brokerAccount.findUnique({
        where: { id: _active.id },
        include: { config: true },
      })
    : null;
  if (!account?.config) {
    return NextResponse.json({ error: "계좌/설정 없음" }, { status: 400 });
  }

  const config = await prisma.strategyConfig.update({
    where: { id: account.config.id },
    data: patch,
  });
  return NextResponse.json({ ok: true, config });
}

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
  if (!account) return NextResponse.json({ error: "no account" }, { status: 400 });

  await prisma.basket.updateMany({
    where: { accountId: account.id, tradingPaused: true },
    data: { tradingPaused: false },
  });
  return NextResponse.json({ ok: true });
}
