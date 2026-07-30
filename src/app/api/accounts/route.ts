import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import {
  MAX_BROKER_ACCOUNTS_PER_USER,
  accountLabel,
  deleteBrokerAccountForUser,
  listUserBrokerAccounts,
  resolveActiveBrokerAccount,
  setActiveBrokerAccount,
} from "@/lib/account-selection";
import { ensureTradingSchema, prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";

export const runtime = "nodejs";

function serializeAccount(
  a: Awaited<ReturnType<typeof listUserBrokerAccounts>>[number],
  activeId: string | null,
) {
  return {
    id: a.id,
    displayName: a.displayName,
    label: accountLabel(a),
    login: a.login,
    server: a.server,
    status: a.status,
    statusMessage: a.statusMessage,
    metaApiAccountId: a.metaApiAccountId,
    botEnabled: a.botEnabled,
    balance: a.balance,
    equity: a.equity,
    startingBalance: a.startingBalance,
    tpCount: a.tpCount,
    slCount: a.slCount,
    cycleCount: a.cycleCount,
    lastSyncAt: a.lastSyncAt,
    openBaskets: a._count.baskets,
    linked: Boolean(a.metaApiAccountId),
    active: a.id === activeId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function GET() {
  await ensureTradingSchema();
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const [accounts, active] = await Promise.all([
    listUserBrokerAccounts(gate.user.id),
    resolveActiveBrokerAccount(gate.user.id),
  ]);
  const activeId = active?.id ?? null;

  return NextResponse.json({
    ok: true,
    maxAccounts: MAX_BROKER_ACCOUNTS_PER_USER,
    activeAccountId: activeId,
    accounts: accounts.map((a) => serializeAccount(a, activeId)),
  });
}

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("select"),
    accountId: z.string().min(1),
  }),
  z.object({
    action: z.literal("rename"),
    accountId: z.string().min(1),
    displayName: z
      .string()
      .trim()
      .max(40, "계좌 이름은 40자 이내로 입력하세요.")
      .optional()
      .nullable(),
  }),
]);

export async function PATCH(req: Request) {
  await ensureTradingSchema();
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "요청이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (parsed.data.action === "select") {
    const result = await setActiveBrokerAccount(gate.user.id, parsed.data.accountId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({ ok: true, activeAccountId: result.accountId });
  }

  const name = (parsed.data.displayName ?? "").trim();
  const updated = await prisma.brokerAccount.updateMany({
    where: { id: parsed.data.accountId, userId: gate.user.id },
    data: { displayName: name.length ? name : null },
  });
  if (!updated.count) {
    return NextResponse.json({ error: "계좌를 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    accountId: parsed.data.accountId,
    displayName: name.length ? name : null,
  });
}

const deleteSchema = z.object({
  accountId: z.string().min(1),
});

export async function DELETE(req: Request) {
  await ensureTradingSchema();
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const body = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "accountId가 필요합니다." }, { status: 400 });
  }

  const result = await deleteBrokerAccountForUser(gate.user.id, body.data.accountId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
