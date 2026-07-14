import { gateErrorKo } from "@/lib/ko-errors";
import { requireAdmin } from "@/lib/access";
import { prisma } from "@/lib/db";
import {
  fmtUsd,
  META_RATES,
  monthlyDeployedCost,
  monthlyUndeployedCost,
} from "@/lib/costs";
import { undeployIdleAccounts } from "@/lib/cost-optimize";
import { NextResponse } from "next/server";

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const [users, accounts, fillsToday, openBaskets] = await Promise.all([
    prisma.user.count(),
    prisma.brokerAccount.findMany({
      select: {
        id: true,
        login: true,
        status: true,
        botEnabled: true,
        metaApiAccountId: true,
        lastSyncAt: true,
        balance: true,
        equity: true,
        tpCount: true,
        slCount: true,
        updatedAt: true,
        user: { select: { id: true, email: true } },
      },
    }),
    prisma.fill.count({
      where: {
        createdAt: { gte: new Date(new Date().toISOString().slice(0, 10)) },
      },
    }),
    prisma.basket.count({ where: { status: "open" } }),
  ]);

  const pending = accounts.filter((a) =>
    ["pending_registration", "provisioning"].includes(a.status),
  );
  const connected = accounts.filter((a) => a.status === "connected");
  const undeployed = accounts.filter((a) => a.status === "undeployed");
  const failed = accounts.filter((a) => a.status === "failed");
  const botsOn = accounts.filter((a) => a.botEnabled && a.status === "connected");
  /** Burning money: MetaAPI deployed (connected) but bot off */
  const waste = accounts.filter(
    (a) => a.metaApiAccountId && a.status === "connected" && !a.botEnabled,
  );
  const billingActive = accounts.filter(
    (a) => a.metaApiAccountId && a.status === "connected",
  );
  const billingIdleMeta = accounts.filter(
    (a) => a.metaApiAccountId && a.status === "undeployed",
  );

  const estDeployedMo = monthlyDeployedCost(billingActive.length);
  const estUndeployedMo = monthlyUndeployedCost(billingIdleMeta.length);
  const wasteMo = monthlyDeployedCost(waste.length);
  const optimizedMo = monthlyDeployedCost(botsOn.length) + monthlyUndeployedCost(
    billingIdleMeta.length + waste.length,
  );

  return NextResponse.json({
    summary: {
      users,
      accounts: accounts.length,
      pending: pending.length,
      connected: connected.length,
      undeployed: undeployed.length,
      failed: failed.length,
      botsOn: botsOn.length,
      openBaskets,
      fillsToday,
      waste: waste.length,
      billingActive: billingActive.length,
    },
    cost: {
      rates: META_RATES,
      estimatedMonthlyUsd: estDeployedMo + estUndeployedMo,
      deployedMonthlyUsd: estDeployedMo,
      undeployedMonthlyUsd: estUndeployedMo,
      wasteMonthlyUsd: wasteMo,
      afterOptimizeMonthlyUsd: optimizedMo,
      potentialSaveUsd: Math.max(0, estDeployedMo + estUndeployedMo - optimizedMo),
      fmt: {
        estimated: fmtUsd(estDeployedMo + estUndeployedMo),
        waste: fmtUsd(wasteMo),
        afterOptimize: fmtUsd(optimizedMo),
        save: fmtUsd(Math.max(0, estDeployedMo + estUndeployedMo - optimizedMo)),
      },
    },
    wasteAccounts: waste.map((a) => ({
      id: a.id,
      login: a.login,
      email: a.user.email,
      userId: a.user.id,
      equity: a.equity,
      lastSyncAt: a.lastSyncAt,
      monthlyBurnUsd: META_RATES.g2HighPerHour * META_RATES.hoursPerMonth,
    })),
    bots: botsOn.map((a) => ({
      id: a.id,
      login: a.login,
      email: a.user.email,
      userId: a.user.id,
      equity: a.equity,
      balance: a.balance,
      tpCount: a.tpCount,
      slCount: a.slCount,
      lastSyncAt: a.lastSyncAt,
    })),
    pendingAccounts: pending.map((a) => ({
      id: a.id,
      login: a.login,
      email: a.user.email,
      userId: a.user.id,
      status: a.status,
    })),
  });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const body = await req.json().catch(() => ({}));
  if (body?.action === "optimize") {
    const result = await undeployIdleAccounts();
    return NextResponse.json({
      ok: true,
      message: `미사용 클라우드 ${result.count}건 중지 완료`,
      ...result,
    });
  }
  return NextResponse.json({ error: "알 수 없는 요청입니다." }, { status: 400 });
}
