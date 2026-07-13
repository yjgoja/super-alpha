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
  const [doneToken, setDoneToken] = useState<string | null>(null);

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
    setDoneToken(data.account?.syncToken || "");
    setTimeout(() => router.push("/dashboard"), 2500);
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
          계좌를 연결한 뒤, EA Sync Token으로 실데이터를 동기화합니다.
        </p>

        {doneToken !== null ? (
          <div className="mt-8 rounded-2xl border border-[var(--accent)]/40 bg-[rgba(200,245,66,0.08)] p-5">
            <div className="font-display text-2xl text-[var(--accent)]">연결 완료</div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              대시보드에서 Sync Token을 EA에 넣으면 MT5 실데이터가 표시됩니다.
            </p>
            <code className="mt-3 block break-all text-xs text-[var(--accent2)]">
              {doneToken}
            </code>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div>
              <label className="sa-label">계좌번호 (MT5 Login)</label>
              <input
                className="sa-input"
                inputMode="numeric"
                required
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="예: 135055717"
              />
            </div>
            <div>
              <label className="sa-label">암호 (MT5 Password)</label>
              <input
                className="sa-input"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="거래 비밀번호"
              />
            </div>
            <div>
              <label className="sa-label">서버 (MT5 Server)</label>
              <input
                className="sa-input opacity-80"
                value={FIXED_MT5_SERVER}
                readOnly
              />
            </div>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <button className="sa-btn sa-btn-primary w-full" disabled={loading}>
              {loading ? "연결 중…" : "즉시 연결하기"}
            </button>
          </div>
        )}
      </form>
    </main>
  );
}
