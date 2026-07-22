import { createHash, randomBytes } from "crypto";
import { Resend } from "resend";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h

export function siteUrl() {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/\/$/, "");
  if (vercel) return `https://${vercel}`;
  return "https://www.superalpha.kr";
}

export function hashVerifyToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createEmailVerifyToken() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashVerifyToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  };
}

export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function fromAddress() {
  return (
    process.env.EMAIL_FROM?.trim() ||
    "슈퍼알파 <noreply@superalpha.kr>"
  );
}

export async function sendVerificationEmail(opts: {
  to: string;
  token: string;
}) {
  if (!mailConfigured()) {
    throw new Error(
      "이메일 발송이 설정되지 않았습니다. 관리자에게 문의하세요. (RESEND_API_KEY)",
    );
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const verifyUrl = `${siteUrl()}/verify-email?token=${encodeURIComponent(opts.token)}`;
  const { error } = await resend.emails.send({
    from: fromAddress(),
    to: opts.to,
    subject: "[슈퍼알파] 이메일 인증을 완료해 주세요",
    html: `
      <div style="font-family:system-ui,sans-serif;line-height:1.6;color:#111;max-width:520px;margin:0 auto;padding:24px">
        <h1 style="font-size:20px;margin:0 0 12px">슈퍼알파 이메일 인증</h1>
        <p style="margin:0 0 16px;color:#444">
          회원가입을 완료하려면 아래 버튼을 눌러 이메일을 인증해 주세요.
          링크는 24시간 동안 유효합니다.
        </p>
        <p style="margin:0 0 24px">
          <a href="${verifyUrl}"
             style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">
            이메일 인증하기
          </a>
        </p>
        <p style="margin:0;font-size:12px;color:#888;word-break:break-all">
          버튼이 안 되면 이 링크를 브라우저에 붙여넣으세요:<br/>${verifyUrl}
        </p>
      </div>
    `,
    text: `슈퍼알파 이메일 인증\n\n아래 링크를 클릭하면 인증이 완료됩니다 (24시간 유효):\n${verifyUrl}\n`,
  });
  if (error) {
    throw new Error(error.message || "이메일 발송에 실패했습니다.");
  }
}
