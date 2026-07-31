import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  createPasswordResetToken,
  mailConfigured,
  sendPasswordResetEmail,
} from "@/lib/mail";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().trim().email("올바른 이메일을 입력하세요."),
});

const OK_MSG =
  "해당 이메일이 가입되어 있으면 비밀번호 재설정 안내 메일을 보냈습니다. 메일함(스팸함 포함)을 확인해 주세요.";

/** Request password-reset email. Always returns the same ok message (no account leak). */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(`forgot-password:${ip}`, {
    limit: 8,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: `요청이 너무 많습니다. ${rl.retryAfterSec}초 후 다시 시도하세요.`,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  if (!mailConfigured()) {
    return NextResponse.json(
      {
        error:
          "현재 이메일 발송이 준비 중입니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
      },
      { status: 503 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "이메일을 확인해 주세요." },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Same response whether or not the user exists.
  if (!user) {
    return NextResponse.json({ ok: true, message: OK_MSG });
  }

  const rlEmail = rateLimit(`forgot-password-email:${email}`, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rlEmail.ok) {
    return NextResponse.json({ ok: true, message: OK_MSG });
  }

  const { token, tokenHash, expiresAt } = createPasswordResetToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
    },
  });

  try {
    await sendPasswordResetEmail({ to: email, token });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "이메일 발송 실패";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  return NextResponse.json({ ok: true, message: OK_MSG });
}
