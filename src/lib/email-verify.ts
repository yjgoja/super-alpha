import { prisma } from "@/lib/db";
import { hashVerifyToken } from "@/lib/mail";

export async function verifyEmailWithToken(token: string): Promise<
  | { ok: true; email: string }
  | { ok: false; error: string }
> {
  const raw = token.trim();
  if (!raw || raw.length < 16) {
    return { ok: false, error: "인증 링크가 올바르지 않습니다." };
  }
  const tokenHash = hashVerifyToken(raw);
  const user = await prisma.user.findFirst({
    where: {
      emailVerifyTokenHash: tokenHash,
      emailVerifyExpiresAt: { gt: new Date() },
    },
  });
  if (!user) {
    return {
      ok: false,
      error: "인증 링크가 만료되었거나 이미 사용되었습니다. 로그인 화면에서 재발송해 주세요.",
    };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
    },
  });
  return { ok: true, email: user.email };
}

export function isEmailVerified(user: {
  emailVerifiedAt: Date | null;
  role: string;
}) {
  if (user.role === "admin") return true;
  return !!user.emailVerifiedAt;
}
