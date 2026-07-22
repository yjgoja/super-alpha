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
import { withAccountToggleLock } from "@/lib/toggle-lock";

export const maxDuration = 60;

async function stopBotAfterManualClose(accountId: string) {
  await prisma.brokerAccount.update({
    where: { id: accountId },
    data: {
      botEnabled: false,
      botStoppedAt: new Date(),
      statusMessage: "수동 청산 · 자동매매 전체 중지됨 (열린 포지션은 익절·손절만 관리)",
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

  return withAccountToggleLock(account.id, async () => {
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
        // MetaErr(스냅샷 실패) vs 부분 청산 실패 구분
        if (!result.ok && !("closed" in result)) {
          return NextResponse.json({ error: result.message }, { status: 400 });
        }

        const closed = "closed" in result ? result.closed : 0;
        const remaining = result.ok ? 0 : "remaining" in result ? result.remaining : -1;

        if (remaining === 0) {
          await prisma.basket.updateMany({
            where: { accountId: account.id, status: "open" },
            data: { status: "closed", lastExitAt: new Date(), unrealizedPnl: 0 },
          });
        }

        if (before.ok && closed > 0) {
          let toRecord = before.positions;
          if (remaining > 0) {
            const after = await fetchSnapshot(metaId);
            const remIds = new Set(
              after.ok ? after.positions.map((p) => p.id).filter(Boolean) : [],
            );
            toRecord = before.positions.filter((p) => !p.id || !remIds.has(p.id));
          }
          for (const p of toRecord) {
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

        if (!result.ok) {
          return NextResponse.json(
            {
              ok: false,
              closed,
              remaining,
              botEnabled: false,
              error: result.message,
              message: result.message,
            },
            { status: 400 },
          );
        }

        return NextResponse.json({
          ok: true,
          closed,
          remaining: 0,
          botEnabled: false,
          message: `전체 ${closed}건 청산 · 자동매매 중지됨`,
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

      const posDir = pos.direction === "SELL" ? "SELL" : "BUY";
      const openLeft = snap.positions.filter(
        (p) =>
          p.id !== body.positionId &&
          symbolsMatch(p.symbol, pos.symbol) &&
          (p.direction === "SELL" ? "SELL" : "BUY") === posDir,
      );
      if (openLeft.length === 0) {
        const openBaskets = await prisma.basket.findMany({
          where: { accountId: account.id, status: "open" },
        });
        for (const b of openBaskets) {
          const bDir = b.direction === "SELL" ? "SELL" : "BUY";
          if (symbolsMatch(b.symbol, pos.symbol) && bDir === posDir) {
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
  });
}
