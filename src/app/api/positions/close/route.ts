import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApprovedUser } from "@/lib/access";
import { prisma } from "@/lib/db";
import { gateErrorKo, toKoreanError } from "@/lib/ko-errors";
import {
  closeAllPositions,
  closePosition,
  ensureCloudLive,
  fetchSnapshot,
  symbolsMatch,
} from "@/lib/metaapi";

export const maxDuration = 60;

async function stopBotAfterManualClose(accountId: string) {
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      botEnabled: false,
      botStoppedAt: new Date(),
      statusMessage: "수동 청산 · 자동매매 전체 중지됨",
    },
  });
}

const bodySchema = z.object({
  positionId: z.string().min(1).optional(),
  all: z.boolean().optional(),
});

/** 수동 청산: 단일 포지션 또는 전체 */
export async function POST(req: Request) {
  const gate = await requireApprovedUser();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "요청이 올바르지 않습니다." }, { status: 400 });
  }
  const body = parsed.data;
  if (!body.all && !body.positionId) {
    return NextResponse.json({ error: "청산할 포지션을 지정하세요." }, { status: 400 });
  }

  const account = await prisma.brokerAccount.findFirst({
    where: { userId: gate.user.id },
    orderBy: { createdAt: "desc" },
  });
  if (!account?.metaApiAccountId) {
    return NextResponse.json({ error: "연결된 계좌가 없습니다." }, { status: 400 });
  }

  try {
    const live = await ensureCloudLive(String(account.metaApiAccountId), 45000);
    if (!live.ok) {
      return NextResponse.json(
        { error: live.message || "클라우드 연결에 실패했습니다." },
        { status: 400 },
      );
    }

    const metaId = String(account.metaApiAccountId);

    if (body.all) {
      const before = await fetchSnapshot(metaId);
      const result = await closeAllPositions(metaId);
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      await prisma.basket.updateMany({
        where: { accountId: account.id, status: "open" },
        data: { status: "closed", lastExitAt: new Date(), unrealizedPnl: 0 },
      });
      if (before.ok) {
        for (const p of before.positions) {
          await prisma.fill.create({
            data: {
              accountId: account.id,
              symbol: p.symbol,
              side: p.direction === "BUY" ? "SELL" : "BUY",
              lots: p.lots,
              price: p.price,
              pnl: p.profit,
              kind: "MANUAL",
              note: "close_all",
            },
          });
        }
      }
      await stopBotAfterManualClose(account.id);
      return NextResponse.json({
        ok: true,
        closed: result.closed,
        botEnabled: false,
        message: `전체 ${result.closed}건 청산 · 자동매매 중지됨`,
      });
    }

    const snap = await fetchSnapshot(metaId);
    if (!snap.ok) {
      return NextResponse.json({ error: snap.message }, { status: 400 });
    }
    const pos = snap.positions.find((p) => p.id === body.positionId);
    if (!pos) {
      return NextResponse.json({ error: "포지션을 찾을 수 없습니다." }, { status: 404 });
    }

    const closed = await closePosition(metaId, body.positionId!);
    if (!closed.ok) {
      return NextResponse.json({ error: closed.message }, { status: 400 });
    }

    const openLeft = snap.positions.filter(
      (p) => p.id !== body.positionId && symbolsMatch(p.symbol, pos.symbol),
    );
    if (openLeft.length === 0) {
      const openBaskets = await prisma.basket.findMany({
        where: { accountId: account.id, status: "open" },
      });
      for (const b of openBaskets) {
        if (symbolsMatch(b.symbol, pos.symbol)) {
          await prisma.basket.update({
            where: { id: b.id },
            data: {
              status: "closed",
              lastExitAt: new Date(),
              unrealizedPnl: 0,
              realizedPnl: pos.profit,
            },
          });
        }
      }
    }

    await prisma.fill.create({
      data: {
        accountId: account.id,
        symbol: pos.symbol,
        side: pos.direction === "BUY" ? "SELL" : "BUY",
        lots: pos.lots,
        price: pos.price,
        pnl: pos.profit,
        kind: "MANUAL",
        note: `close_id:${body.positionId}`,
      },
    });

    await stopBotAfterManualClose(account.id);

    return NextResponse.json({
      ok: true,
      closed: 1,
      botEnabled: false,
      message: `${pos.symbol} 청산 · 자동매매 중지됨`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: toKoreanError(e, "청산에 실패했습니다.") },
      { status: 400 },
    );
  }
}
