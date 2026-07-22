import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  withSessionCookie,
} from "@/lib/auth";
import { isAdminEmail, autoApproveUsers } from "@/lib/access";
import { prisma } from "@/lib/db";
import { isEmailVerified } from "@/lib/email-verify";
import {
  createEmailVerifyToken,
  mailConfigured,
  sendVerificationEmail,
} from "@/lib/mail";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const loginIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .refine(
    (v) => z.string().email().safeParse(v).success || /^[a-zA-Z0-9._-]+$/.test(v),
    { message: "이메일을 입력하세요." },
  );

const schema = z.object({
  email: loginIdSchema,
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상이어야 합니다.")
    .max(72),
  name: z.string().trim().max(60).optional(),
  mode: z.enum(["login", "register"]),
});

async function issueVerification(userId: string, email: string) {
  const { token, tokenHash, expiresAt } = createEmailVerifyToken();
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerifyTokenHash: tokenHash,
      emailVerifyExpiresAt: expiresAt,
    },
  });
  await sendVerificationEmail({ to: email, token });
}

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "입력값을 확인하세요.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    const body = parsed.data;
    const email = body.email.toLowerCase();

    if (body.mode === "register") {
      const emailOk = z.string().email().safeParse(email).success;
      if (!emailOk) {
        return NextResponse.json(
          { error: "회원가입은 이메일 주소로만 가능합니다." },
          { status: 400 },
        );
      }
      if (!mailConfigured()) {
        return NextResponse.json(
          {
            error:
              "현재 이메일 인증 발송이 준비 중입니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
          },
          { status: 503 },
        );
      }

      const rl = rateLimit(`register:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
      if (!rl.ok) {
        return NextResponse.json(
          { error: `가입 요청이 너무 많습니다. ${rl.retryAfterSec}초 후 다시 시도하세요.` },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
      }
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        if (!exists.emailVerifiedAt && exists.role !== "admin") {
          // Allow re-sending verification for unfinished signup with same password
          const passOk = await verifyPassword(body.password, exists.passwordHash);
          if (!passOk) {
            return NextResponse.json({ error: "이미 가입된 이메일입니다." }, { status: 400 });
          }
          try {
            await issueVerification(exists.id, email);
          } catch (e) {
            const msg = e instanceof Error ? e.message : "이메일 발송 실패";
            return NextResponse.json({ error: msg }, { status: 502 });
          }
          return NextResponse.json({
            ok: true,
            needsEmailVerification: true,
            message: "인증 메일을 다시 보냈습니다. 메일함의 링크를 클릭해 주세요.",
          });
        }
        return NextResponse.json({ error: "이미 가입된 이메일입니다." }, { status: 400 });
      }

      const admin = isAdminEmail(email);
      const approvalStatus =
        admin || autoApproveUsers() ? "approved" : "pending";
      const user = await prisma.user.create({
        data: {
          email,
          name: body.name || email.split("@")[0],
          passwordHash: await hashPassword(body.password),
          role: admin ? "admin" : "user",
          approvalStatus,
          // Admin skip inbox verify; normal users must click email link
          emailVerifiedAt: admin ? new Date() : null,
        },
      });

      if (!admin) {
        try {
          await issueVerification(user.id, email);
        } catch (e) {
          await prisma.user.delete({ where: { id: user.id } }).catch(() => null);
          const msg = e instanceof Error ? e.message : "이메일 발송 실패";
          return NextResponse.json({ error: msg }, { status: 502 });
        }
        return NextResponse.json({
          ok: true,
          needsEmailVerification: true,
          message:
            "가입 신청이 접수되었습니다. 이메일로 보낸 인증 링크를 클릭하면 가입이 완료됩니다.",
        });
      }

      // Admin: session immediately
      const token = await createSessionToken(user.id);
      return withSessionCookie(
        NextResponse.json({
          ok: true,
          userId: user.id,
          role: user.role,
          approvalStatus: user.approvalStatus,
          hasBrokerAccount: false,
        }),
        token,
      );
    }

    const rlLogin = rateLimit(`login:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 });
    if (!rlLogin.ok) {
      return NextResponse.json(
        { error: `로그인 시도가 너무 많습니다. ${rlLogin.retryAfterSec}초 후 다시 시도하세요.` },
        { status: 429, headers: { "Retry-After": String(rlLogin.retryAfterSec) } },
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { _count: { select: { accounts: true } } },
    });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json(
        { error: "이메일 또는 비밀번호가 올바르지 않습니다." },
        { status: 401 },
      );
    }
    if (!isEmailVerified(user)) {
      return NextResponse.json(
        {
          error: "이메일 인증이 완료되지 않았습니다. 메일함의 인증 링크를 클릭해 주세요.",
          code: "email_unverified",
          email: user.email,
        },
        { status: 403 },
      );
    }
    if (user.approvalStatus === "rejected") {
      return NextResponse.json(
        { error: "관리자에 의해 이용이 거절된 계정입니다." },
        { status: 403 },
      );
    }
    const token = await createSessionToken(user.id);
    return withSessionCookie(
      NextResponse.json({
        ok: true,
        userId: user.id,
        role: user.role,
        approvalStatus: user.approvalStatus,
        hasBrokerAccount: user._count.accounts > 0,
      }),
      token,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "요청 오류";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
