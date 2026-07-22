"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { resolvePostLoginPath } from "@/lib/post-login";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMode = params.get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState(
    params.get("verified") === "1"
      ? "이메일 인증이 완료되었습니다. 로그인해 주세요."
      : "",
  );
  const [loading, setLoading] = useState(false);
  const [unverified, setUnverified] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");
    setUnverified(false);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, mode }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "실패");
      if (data.code === "email_unverified") setUnverified(true);
      return;
    }
    if (data.needsEmailVerification) {
      setMode("login");
      setInfo(
        data.message ||
          "인증 메일을 보냈습니다. 메일함의 링크를 클릭한 뒤 로그인해 주세요.",
      );
      return;
    }
    router.push(
      resolvePostLoginPath({
        role: data.role || "user",
        approvalStatus: data.approvalStatus || "pending",
        hasBrokerAccount: !!data.hasBrokerAccount,
      }),
    );
  }

  async function resendVerification() {
    setLoading(true);
    setError("");
    setInfo("");
    const res = await fetch("/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "재발송 실패");
      return;
    }
    setInfo(data.message || "인증 메일을 다시 보냈습니다.");
  }

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <form onSubmit={onSubmit} className="sa-panel w-full max-w-md sa-rise">
        <Link href="/" className="font-display text-2xl">
          Super Alpha
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">
          {mode === "login" ? "로그인" : "회원가입"}
        </h1>
        <p
          className={
            mode === "register"
              ? "mt-3 rounded-xl border border-[rgba(232,195,106,0.35)] bg-[rgba(232,195,106,0.12)] px-3.5 py-3 text-[0.92rem] font-semibold leading-relaxed text-[var(--gold)]"
              : "mt-2 text-sm text-[var(--muted)]"
          }
        >
          {mode === "register"
            ? "이메일로 가입하면 인증 링크가 발송됩니다. 링크를 클릭해야 가입이 완료됩니다."
            : "가입 후 봇·매매는 실계좌 연결 후 이용하세요."}
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="sa-label">이메일</label>
            <input
              className="sa-input"
              type={mode === "register" ? "email" : "text"}
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={mode === "register" ? "you@email.com" : "이메일"}
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

        {info && <p className="mt-4 text-sm text-[var(--ok,#5ddea5)]">{info}</p>}
        {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}

        {unverified && (
          <button
            type="button"
            className="mt-3 w-full text-sm text-[var(--gold)] underline"
            disabled={loading}
            onClick={resendVerification}
          >
            인증 메일 다시 받기
          </button>
        )}

        <button className="sa-btn sa-btn-primary mt-6 w-full" disabled={loading}>
          {loading
            ? "처리 중…"
            : mode === "login"
              ? "로그인"
              : "가입하고 인증 메일 받기"}
        </button>

        <button
          type="button"
          className="mt-4 w-full text-sm text-[var(--muted)]"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
            setInfo("");
            setUnverified(false);
          }}
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
