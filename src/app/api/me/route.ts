import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/access";
import {
  accountLabel,
  listUserBrokerAccounts,
  resolveActiveBrokerAccount,
} from "@/lib/account-selection";
import { ensureTradingSchema } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { resolvePostLoginPath } from "@/lib/post-login";

export async function GET() {
  await ensureTradingSchema();
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: gateErrorKo("unauthorized") }, { status: 401 });
  }

  const [accounts, active] = await Promise.all([
    listUserBrokerAccounts(user.id),
    resolveActiveBrokerAccount(user.id),
  ]);

  const hasBrokerAccount = accounts.length > 0;
  const linked = Boolean(active?.metaApiAccountId);
  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    approvalStatus: user.approvalStatus,
    hasBrokerAccount,
    linked,
    activeAccountId: active?.id ?? null,
    accounts: accounts.map((a) => ({
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
      linked: Boolean(a.metaApiAccountId),
      active: a.id === active?.id,
      openBaskets: a._count.baskets,
    })),
    account: active
      ? {
          id: active.id,
          displayName: active.displayName,
          label: accountLabel(active),
          login: active.login,
          server: active.server,
          status: active.status,
          statusMessage: active.statusMessage,
          metaApiAccountId: active.metaApiAccountId,
          botEnabled: active.botEnabled,
          balance: active.balance,
          equity: active.equity,
        }
      : null,
    next: resolvePostLoginPath({
      role: user.role,
      approvalStatus: user.approvalStatus,
      hasBrokerAccount,
    }),
  });
}
