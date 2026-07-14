import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/access";
import { prisma } from "@/lib/db";
import { deleteUserCompletely, purgeMetaAccount, undeployIdleAccounts } from "@/lib/cost-optimize";
import { gateErrorKo, toKoreanError } from "@/lib/ko-errors";
import { undeployAccount } from "@/lib/metaapi";
import { finalizeAllProvisioning, runAdminProvision } from "@/lib/provision";

export const maxDuration = 60;

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  try {
    await finalizeAllProvisioning();
  } catch {
    /* non-fatal */
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      approvalStatus: true,
      createdAt: true,
      accounts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          login: true,
          server: true,
          status: true,
          statusMessage: true,
          mode: true,
          botEnabled: true,
          lastSyncAt: true,
          metaApiAccountId: true,
          balance: true,
          equity: true,
          tpCount: true,
          slCount: true,
          cycleCount: true,
        },
      },
    },
  });

  return NextResponse.json({ users });
}

const patchSchema = z.object({
  userId: z.string().optional(),
  approvalStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  accountId: z.string().optional(),
  action: z
    .enum([
      "provision",
      "undeploy",
      "reject_account",
      "purge_meta",
      "optimize_idle",
      "delete_user",
      "stop_bot",
      "check_provision",
    ])
    .optional(),
});

export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "입력값이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    if (parsed.data.action === "optimize_idle") {
      const result = await undeployIdleAccounts();
      return NextResponse.json({
        ok: true,
        message: `미사용 ${result.count}건 클라우드 중지`,
        ...result,
      });
    }

    if (parsed.data.action === "check_provision") {
      const results = await finalizeAllProvisioning();
      return NextResponse.json({ ok: true, results });
    }

    if (parsed.data.action === "delete_user" && parsed.data.userId) {
      const result = await deleteUserCompletely(parsed.data.userId, gate.user.id);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, message: `${result.email} 회원이 삭제되었습니다.` });
    }

    if (parsed.data.userId && parsed.data.approvalStatus) {
      if (parsed.data.userId === gate.user.id && parsed.data.approvalStatus !== "approved") {
        return NextResponse.json(
          { error: "본인 관리자 계정은 거절할 수 없습니다." },
          { status: 400 },
        );
      }
      const user = await prisma.user.update({
        where: { id: parsed.data.userId },
        data: { approvalStatus: parsed.data.approvalStatus },
        select: { id: true, email: true, approvalStatus: true, role: true },
      });
      return NextResponse.json({ ok: true, user });
    }

    if (parsed.data.accountId && parsed.data.action === "provision") {
      const result = await runAdminProvision(parsed.data.accountId);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({
        ok: true,
        pending: result.pending,
        message: result.message,
        status: result.status,
      });
    }

    if (parsed.data.accountId && parsed.data.action === "undeploy") {
      const account = await prisma.brokerAccount.findUnique({
        where: { id: parsed.data.accountId },
      });
      if (!account?.metaApiAccountId) {
        return NextResponse.json({ error: "클라우드 계좌가 없습니다." }, { status: 400 });
      }
      await undeployAccount(account.metaApiAccountId);
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          status: "undeployed",
          botEnabled: false,
          statusMessage: "클라우드가 중지되었습니다(비용 절감).",
        },
      });
      return NextResponse.json({ ok: true, message: "클라우드를 중지했습니다." });
    }

    if (parsed.data.accountId && parsed.data.action === "stop_bot") {
      const account = await prisma.brokerAccount.findUnique({
        where: { id: parsed.data.accountId },
      });
      if (!account) {
        return NextResponse.json({ error: "계좌를 찾을 수 없습니다." }, { status: 404 });
      }
      if (account.metaApiAccountId) {
        await undeployAccount(account.metaApiAccountId);
      }
      await prisma.brokerAccount.update({
        where: { id: account.id },
        data: {
          botEnabled: false,
          status: account.metaApiAccountId ? "undeployed" : account.status,
          statusMessage: "관리자가 봇을 정지하고 클라우드를 중지했습니다.",
        },
      });
      return NextResponse.json({ ok: true, message: "봇을 정지하고 클라우드를 중지했습니다." });
    }

    if (parsed.data.accountId && parsed.data.action === "purge_meta") {
      const result = await purgeMetaAccount(parsed.data.accountId);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, message: "클라우드 계정을 삭제해 과금을 중단했습니다." });
    }

    if (parsed.data.accountId && parsed.data.action === "reject_account") {
      const account = await prisma.brokerAccount.findUnique({
        where: { id: parsed.data.accountId },
      });
      if (account?.metaApiAccountId) {
        try {
          await undeployAccount(account.metaApiAccountId);
        } catch {
          /* ignore */
        }
        await purgeMetaAccount(account.id);
      } else if (account) {
        await prisma.brokerAccount.update({
          where: { id: account.id },
          data: {
            status: "failed",
            statusMessage: "관리자가 계좌 연동을 거절했습니다.",
            botEnabled: false,
            syncToken: null,
          },
        });
      }
      return NextResponse.json({ ok: true, message: "계좌 연동을 거절했습니다." });
    }

    return NextResponse.json({ error: "처리할 작업이 없습니다." }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: toKoreanError(e, "처리 중 오류가 발생했습니다.") },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }
  const body = z.object({ userId: z.string() }).safeParse(await req.json());
  if (!body.success) {
    return NextResponse.json({ error: "회원 ID가 필요합니다." }, { status: 400 });
  }
  const result = await deleteUserCompletely(body.data.userId, gate.user.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, message: `${result.email} 회원이 삭제되었습니다.` });
}
