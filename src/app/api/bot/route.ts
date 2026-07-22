import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";
import { ensureCloudLive } from "@/lib/metaapi";
import { withAccountToggleLock } from "@/lib/toggle-lock";

export const maxDuration = 60;
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
      status: { in: ["connected", "undeployed"] },
      metaApiAccountId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    include: {
      baskets: { where: { status: "open" }, select: { id: true } },
    },
  });
  if (!account?.metaApiAccountId) {
    return NextResponse.json({ error: "연결된 계좌가 없습니다." }, { status: 400 });
  }

  return withAccountToggleLock(account.id, async () => {
    if (body.enabled) {
      const live = await ensureCloudLive(String(account.metaApiAccountId), 45000);
      if (!live.ok) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            statusMessage: live.message || "클라우드 재활성화 실패",
          },
        });
        return NextResponse.json(
          { error: live.message || "클라우드 계좌를 활성화하지 못했습니다." },
          { status: 400 },
        );
      }

      const updated = await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          botEnabled: true,
          botStoppedAt: null,
          status: "connected",
          statusMessage: "클라우드 연결 · 봇 실행 중",
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
