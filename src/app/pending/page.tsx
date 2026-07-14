"use client";

import Link from "next/link";

export default function PendingPage() {
  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <section className="sa-panel max-w-md text-center space-y-4">
        <h1 className="text-xl font-semibold text-[var(--fg)]">승인 대기 중</h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          가입은 완료되었습니다. 관리자가 계정을 승인한 뒤 계좌 연결·봇을 사용할 수
          있습니다.
        </p>
        <Link href="/login" className="inline-block text-[var(--gold)] text-sm underline">
          로그인으로 돌아가기
        </Link>
      </section>
    </main>
  );
}
