"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setError(
          (typeof data.error === "string" && data.error) ||
            "요청에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        );
        return;
      }
      setInfo(
        (typeof data.message === "string" && data.message) ||
          "해당 이메일이 가입되어 있으면 재설정 메일을 보냈습니다.",
      );
    } catch {
      setError("네트워크 오류로 요청하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <form onSubmit={onSubmit} className="sa-panel w-full max-w-md sa-rise">
        <Link href="/" className="font-display text-2xl">
          Super Alpha
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">비밀번호 찾기</h1>
        <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
          가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내 드립니다.
          링크는 1시간 동안 유효합니다.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="sa-label">이메일</label>
            <input
              className="sa-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
            />
          </div>
        </div>

        {info && <p className="mt-4 text-sm text-[var(--ok,#5ddea5)]">{info}</p>}
        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}

        <button className="sa-btn sa-btn-primary mt-6 w-full" disabled={loading}>
          {loading ? "처리 중…" : "재설정 메일 받기"}
        </button>

        <Link
          href="/login"
          className="mt-4 block w-full text-center text-sm text-[var(--muted)]"
        >
          로그인으로 돌아가기
        </Link>
      </form>
    </main>
  );
}
