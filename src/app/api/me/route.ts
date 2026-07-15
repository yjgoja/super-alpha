import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { resolvePostLoginPath } from "@/lib/post-login";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: gateErrorKo("unauthorized") }, { status: 401 });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: user.id },
    select: {
      id: true,
      login: true,
      status: true,
      metaApiAccountId: true,
      botEnabled: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const hasBrokerAccount = !!account;
  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    approvalStatus: user.approvalStatus,
    hasBrokerAccount,
    account: account
      ? {
          id: account.id,
          login: account.login,
          status: account.status,
          metaApiAccountId: account.metaApiAccountId,
          botEnabled: account.botEnabled,
        }
      : null,
    next: resolvePostLoginPath({
      role: user.role,
      approvalStatus: user.approvalStatus,
      hasBrokerAccount,
    }),
  });
}
