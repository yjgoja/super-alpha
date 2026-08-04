import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/access";
import {
  accountLabel,
  listAllBrokerAccountsForAdmin,
} from "@/lib/account-selection";
import { ensureTradingSchema } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";

export const runtime = "nodejs";

/** Compact account list for admin remote editing on phone. */
export async function GET() {
  await ensureTradingSchema();
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const rows = await listAllBrokerAccountsForAdmin();
  return NextResponse.json({
    ok: true,
    accounts: rows.map((a) => ({
      id: a.id,
      label: accountLabel(a),
      login: a.login,
      server: a.server,
      status: a.status,
      botEnabled: a.botEnabled,
      balance: a.balance,
      equity: a.equity,
      openBaskets: a._count.baskets,
      userId: a.userId,
      email: a.user.email,
      name: a.user.name,
    })),
  });
}
