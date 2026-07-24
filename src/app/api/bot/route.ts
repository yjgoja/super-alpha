import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { ensureAccountCloudLive, ensureCloudLive } from "@/lib/metaapi";
import { withAccountToggleLock } from "@/lib/toggle-lock";

export const maxDuration = 90;
export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const body = z.object({ enabled: z.boolean() }).parse(await req.json());
  const account = await prisma.brokerAccount.findFirst({
    where: {
      userId: gate.user.id,
      OR: [
        {
          status: { in: ["connected", "undeployed"] },
          metaApiAccountId: { not: null },
        },
        // Allow recovery of failed links when password is still stored
        {
          status: "failed",
          syncToken: { not: null },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: {
      baskets: { where: { status: "open" }, select: { id: true } },
    },
  });
  if (!account || (!account.metaApiAccountId && !account.syncToken)) {
    return NextResponse.json({ error: "연결된 계좌가 없습니다." }, { status: 400 });
  }

  return withAccountToggleLock(account.id, async () => {
    if (body.enabled) {
      let metaId = String(account.metaApiAccountId);
      let snapBalance: number | undefined;
      let snapEquity: number | undefined;
      let errMsg: string | undefined;

      if (account.syncToken) {
        const repaired = await ensureAccountCloudLive({
          metaApiAccountId: account.metaApiAccountId,
          login: account.login,
          password: account.syncToken,
          server: account.server,
          waitMs: 60000,
          // Recreate only when previously failed / missing cloud
          allowRecreate: account.status === "failed" || !account.metaApiAccountId,
        });
        if (!repaired.ok) {
          // Rate-limit on reconnect: if cloud already exists, still turn bot ON.
          if (
            /너무 많|rate|429|요청 한도/i.test(repaired.message) &&
            account.metaApiAccountId
          ) {
            errMsg = undefined;
            metaId = String(account.metaApiAccountId);
          } else {
            errMsg = repaired.message;
          }
        } else {
          metaId = repaired.metaApiAccountId;
          snapBalance = repaired.snap.balance;
          snapEquity = repaired.snap.equity;
        }
      } else {
        const live = await ensureCloudLive(metaId, 45000);
        if (!live.ok) {
          errMsg = live.message;
        } else {
          snapBalance = live.snap.balance;
          snapEquity = live.snap.equity;
        }
      }

      if (errMsg) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            statusMessage: errMsg || "클라우드 재활성화 실패",
          },
        });
        return NextResponse.json(
          { error: errMsg || "클라우드 계좌를 활성화하지 못했습니다." },
          { status: 400 },
        );
      }

      const updated = await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          metaApiAccountId: metaId,
          botEnabled: true,
          botStoppedAt: null,
          status: "connected",
          statusMessage: "클라우드 연결 · 봇 실행 중",
          ...(snapBalance != null && snapEquity != null
            ? {
                balance: snapBalance,
                equity: snapEquity,
                lastSyncAt: new Date(),
              }
            : {}),
        },
      });
      return NextResponse.json({ ok: true, botEnabled: updated.botEnabled });
    }

    const openCount = account.baskets.length;
    const updated = await prisma.brokerAccount.update({
      where: { id: account.id },
      data: {
        botEnabled: false,
        botStoppedAt: new Date(),
        statusMessage:
          openCount > 0
            ? `봇 중지 · 열린 포지션 ${openCount}건 익절·손절만 계속 관리`
            : "봇 중지됨 · 24시간 후 클라우드 자동 중지(비용 절감)",
      },
    });
    return NextResponse.json({
      ok: true,
      botEnabled: updated.botEnabled,
      openBaskets: openCount,
    });
  });
}
