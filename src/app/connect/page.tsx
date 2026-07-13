"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { FIXED_MT5_SERVER } from "@/lib/dca";

export default function ConnectPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, server: FIXED_MT5_SERVER }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "연결 실패");
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/dashboard"), 1800);
  }

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <form onSubmit={onSubmit} className="sa-panel w-full max-w-lg sa-rise">
        <div className="flex items-center justify-between">
          <Link href="/" className="font-display text-2xl">
            Super Alpha
          </Link>
          <span className="sa-badge sa-badge-live">ZeroMarkets-1</span>
        </div>

        <h1 className="mt-6 text-2xl font-semibold">MT5 계좌 연결</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          실제 MT5 계좌번호와 거래 비밀번호를 입력하세요. 별도 토큰은 없습니다.
          EA가 같은 비밀번호로 동기화해야 대시보드에 실데이터가 표시됩니다.
        </p>

        {done ? (
          <div className="mt-8 rounded-2xl border border-[var(--accent)]/40 bg-[rgba(200,245,66,0.08)] p-5">
            <div className="font-display text-2xl text-[var(--accent)]">등록 완료</div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              상태: 대기중 → MT5 EA 연동 후 LIVE로 전환됩니다.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div>
              <label className="sa-label">계좌번호 (MT5 Login)</label>
              <input
                className="sa-input"
                inputMode="numeric"
                required
                pattern="[0-9]{5,15}"
                value={login}
                onChange={(e) => setLogin(e.target.value.replace(/\D/g, ""))}
                placeholder="실제 MT5 계좌번호"
              />
            </div>
            <div>
              <label className="sa-label">거래 비밀번호 (MT5 Password)</label>
              <input
                className="sa-input"
                type="password"
                required
                minLength={4}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="실제 거래 비밀번호"
              />
            </div>
            <div>
              <label className="sa-label">서버</label>
              <input className="sa-input opacity-80" value={FIXED_MT5_SERVER} readOnly />
            </div>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <button className="sa-btn sa-btn-primary w-full" disabled={loading}>
              {loading ? "등록 중…" : "계좌 등록하기"}
            </button>
            <p className="text-xs text-[var(--muted)]">
              잘못된 비밀번호로 등록하면 EA 동기화가 거부됩니다. 브로커 서버에 직접
              로그인 검증은 MetaAPI 연동 단계에서 추가됩니다.
            </p>
          </div>
        )}
      </form>
    </main>
  );
}
