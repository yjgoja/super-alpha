"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = (params.get("token") || "").trim();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(
    token ? "" : "재설정 링크가 없습니다. 비밀번호 찾기를 다시 요청해 주세요.",
  );
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!token) {
      setError("재설정 링크가 없습니다. 비밀번호 찾기를 다시 요청해 주세요.");
      return;
    }
    if (password !== confirm) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setError(
          (typeof data.error === "string" && data.error) ||
            "비밀번호 변경에 실패했습니다.",
        );
        return;
      }
      setInfo(
        (typeof data.message === "string" && data.message) ||
          "비밀번호가 변경되었습니다.",
      );
      window.setTimeout(() => {
        router.replace("/login?reset=1");
      }, 900);
    } catch {
      setError("네트워크 오류로 변경하지 못했습니다. 다시 시도해 주세요.");
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
        <h1 className="mt-6 text-2xl font-semibold">새 비밀번호 설정</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          이메일로 받은 링크로 접속하셨습니다. 새 비밀번호를 입력해 주세요.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="sa-label">새 비밀번호</label>
            <input
              className="sa-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              disabled={!token || loading}
            />
          </div>
          <div>
            <label className="sa-label">새 비밀번호 확인</label>
            <input
              className="sa-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="다시 입력"
              disabled={!token || loading}
            />
          </div>
        </div>

        {info && <p className="mt-4 text-sm text-[var(--ok,#5ddea5)]">{info}</p>}
        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}

        <button
          className="sa-btn sa-btn-primary mt-6 w-full"
          disabled={!token || loading}
        >
          {loading ? "처리 중…" : "비밀번호 변경"}
        </button>

        <div className="mt-4 flex flex-col gap-2 text-center text-sm text-[var(--muted)]">
          <Link href="/forgot-password">재설정 메일 다시 받기</Link>
          <Link href="/login">로그인으로 돌아가기</Link>
        </div>
      </form>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
