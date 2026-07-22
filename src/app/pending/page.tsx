"use client";

import Link from "next/link";

/** Rejected accounts only — signup no longer waits on admin approval. */
export default function PendingPage() {
  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <div className="sa-panel w-full max-w-md sa-rise">
        <Link href="/" className="font-display text-2xl">
          Super Alpha
        </Link>
        <h1 className="mt-6 text-xl font-semibold text-[var(--fg)]">이용이 제한되었습니다</h1>
        <p className="mt-3 text-sm text-[var(--muted)] leading-relaxed">
          관리자에 의해 이용이 거절된 계정입니다. 문의가 필요하면 담당자에게 연락해 주세요.
        </p>
        <Link href="/login" className="sa-btn sa-btn-ghost mt-8 inline-flex">
          로그인으로
        </Link>
      </div>
    </main>
  );
}
