import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashVerifyToken } from "@/lib/mail";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상이어야 합니다.")
    .max(72),
});

/** Apply one-time password-reset token and set a new password. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(`reset-password:${ip}`, {
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: `요청이 너무 많습니다. ${rl.retryAfterSec}초 후 다시 시도하세요.`,
      },
      { status: 429 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message || "입력값을 확인해 주세요.",
      },
      { status: 400 },
    );
  }

  const tokenHash = hashVerifyToken(parsed.data.token);
  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { gt: new Date() },
    },
  });

  if (!user) {
    return NextResponse.json(
      {
        error:
          "재설정 링크가 만료되었거나 이미 사용되었습니다. 비밀번호 찾기를 다시 요청해 주세요.",
      },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      // Reset link proves inbox access — clear pending email verify if needed.
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
    },
  });

  return NextResponse.json({
    ok: true,
    message: "비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.",
  });
}
