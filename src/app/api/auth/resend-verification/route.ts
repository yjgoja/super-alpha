import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import {
  createEmailVerifyToken,
  mailConfigured,
  sendVerificationEmail,
} from "@/lib/mail";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(72),
});

/** Resend verification mail for unfinished signups */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(`resend-verify:${ip}`, { limit: 8, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `재발송 요청이 너무 많습니다. ${rl.retryAfterSec}초 후 다시 시도하세요.` },
      { status: 429 },
    );
  }
  if (!mailConfigured()) {
    return NextResponse.json({ error: "이메일 발송이 설정되지 않았습니다." }, { status: 503 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "이메일과 비밀번호를 확인해 주세요." }, { status: 400 });
  }
  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    // Don't leak account existence
    return NextResponse.json({
      ok: true,
      message: "해당 계정이 있고 미인증이면 메일을 발송했습니다.",
    });
  }
  if (user.emailVerifiedAt || user.role === "admin") {
    return NextResponse.json({ ok: true, message: "이미 인증된 계정입니다. 로그인해 주세요." });
  }

  const { token, tokenHash, expiresAt } = createEmailVerifyToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifyTokenHash: tokenHash, emailVerifyExpiresAt: expiresAt },
  });
  try {
    await sendVerificationEmail({ to: email, token });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "발송 실패";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    message: "인증 메일을 다시 보냈습니다. 메일함(스팸함 포함)을 확인해 주세요.",
  });
}
