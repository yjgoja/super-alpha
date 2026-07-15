"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMode = params.get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, mode }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "실패");
      return;
    }
    if (data.approvalStatus && data.approvalStatus !== "approved") {
      router.push("/pending");
      return;
    }
    router.push("/connect");
  }

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <form onSubmit={onSubmit} className="sa-panel w-full max-w-md sa-rise">
        <Link href="/" className="font-display text-2xl">
          Super Alpha
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">
          {mode === "login" ? "로그인" : "데모 가입"}
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          무설치 · 계좌 연결까지 2분이면 충분합니다.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="sa-label">이메일</label>
            <input
              className="sa-input"
              type="text" autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="master 또는 you@email.com"
            />
          </div>
          <div>
            <label className="sa-label">비밀번호</label>
            <input
              className="sa-input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
            />
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}

        <button className="sa-btn sa-btn-primary mt-6 w-full" disabled={loading}>
          {loading ? "처리 중…" : mode === "login" ? "로그인" : "가입하기"}
        </button>

        <button
          type="button"
          className="mt-4 w-full text-sm text-[var(--muted)]"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "계정이 없나요? 가입하기" : "이미 계정이 있나요? 로그인"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
