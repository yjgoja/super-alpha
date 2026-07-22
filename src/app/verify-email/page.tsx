import Link from "next/link";
import { verifyEmailWithToken } from "@/lib/email-verify";

export const metadata = {
  title: "이메일 인증",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { token } = await searchParams;
  const result = token
    ? await verifyEmailWithToken(token)
    : { ok: false as const, error: "인증 링크가 없습니다." };

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <div className="sa-panel w-full max-w-md sa-rise text-center">
        <Link href="/" className="font-display text-2xl">
          Super Alpha
        </Link>
        {result.ok ? (
          <>
            <h1 className="mt-6 text-2xl font-semibold">이메일 인증 완료</h1>
            <p className="mt-3 text-sm text-[var(--muted)] leading-relaxed">
              <strong className="text-[var(--ink)]">{result.email}</strong> 인증이
              완료되었습니다. 이제 로그인할 수 있습니다.
            </p>
            <Link href="/login?verified=1" className="sa-btn sa-btn-primary mt-8 inline-flex w-full justify-center">
              로그인하기
            </Link>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-semibold">인증 실패</h1>
            <p className="mt-3 text-sm text-[var(--danger)] leading-relaxed">{result.error}</p>
            <Link href="/login?mode=register" className="sa-btn sa-btn-primary mt-8 inline-flex w-full justify-center">
              회원가입으로 이동
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
