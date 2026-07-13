import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = z.object({ enabled: z.boolean() }).parse(await req.json());
  const account = await prisma.brokerAccount.findFirst({
    where: { userId, status: "connected" },
    orderBy: { createdAt: "desc" },
  });
  if (!account) {
    return NextResponse.json({ error: "연결된 계좌가 없습니다." }, { status: 400 });
  }

  const updated = await prisma.brokerAccount.update({
    where: { id: account.id },
    data: { botEnabled: body.enabled },
  });

  return NextResponse.json({ ok: true, botEnabled: updated.botEnabled });
}
