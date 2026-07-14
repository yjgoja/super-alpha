import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/access";
import { prisma } from "@/lib/db";
import { META_RATES, monthlyDeployedCost } from "@/lib/costs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }

  const { id } = await ctx.params;
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      accounts: {
        orderBy: { createdAt: "desc" },
        include: {
          config: true,
          baskets: {
            where: { status: "open" },
            include: { legs: true },
          },
          fills: { orderBy: { createdAt: "desc" }, take: 30 },
          snapshots: { orderBy: { createdAt: "desc" }, take: 24 },
        },
      },
    },
  });

  if (!user) return NextResponse.json({ error: "회원 없음" }, { status: 404 });

  const { passwordHash: _, ...safeUser } = user;
  const accounts = user.accounts.map((a) => {
    const { passwordEnc: _p, syncToken: _s, ...safe } = a;
    const burning = a.metaApiAccountId && a.status === "connected";
    return {
      ...safe,
      cost: {
        burning,
        monthlyUsd: burning
          ? monthlyDeployedCost(1)
          : a.metaApiAccountId && a.status === "undeployed"
            ? META_RATES.undeployedPerHour * META_RATES.hoursPerMonth
            : 0,
      },
    };
  });

  return NextResponse.json({
    user: {
      id: safeUser.id,
      email: safeUser.email,
      name: safeUser.name,
      role: safeUser.role,
      approvalStatus: safeUser.approvalStatus,
      createdAt: safeUser.createdAt,
    },
    accounts,
  });
}
