"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { resolvePostLoginPath } from "@/lib/post-login";
import { clearManualLogoutFlag, wasManualLogout } from "@/lib/logout-client";

const REMEMBER_KEY = "sa_remember_me";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMode = params.get("mode") === "register" ? "register" : "login";
  const loggedOutParam = params.get("logout") === "1";
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(
    params.get("verified") === "1"
      ? "이메일 인증이 완료되었습니다. 로그인해 주세요."
      : loggedOutParam
        ? "로그아웃되었습니다. 다른 계정으로 로그인할 수 있습니다."
        : "",
  );
  const [loading, setLoading] = useState(false);
  const [unverified, setUnverified] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved === "0") setRememberMe(false);
      if (saved === "1") setRememberMe(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Explicit logout → stay on form (account switch). Do not auto-enter.
  // Browser reopen with valid remember-me cookie → still auto-enter.
  // IMPORTANT: do NOT call /api/auth/logout here — that races a subsequent
  // login and clears the new session cookie (stuck on login / "처리 중").
  useEffect(() => {
    if (loggedOutParam || wasManualLogout()) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (!data || cancelled) return;
        router.replace(
          resolvePostLoginPath({
            role: data.role || "user",
            approvalStatus: data.approvalStatus || "pending",
            hasBrokerAccount: !!data.hasBrokerAccount,
          }),
        );
      } catch {
        /* stay on login */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, loggedOutParam]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");
    setUnverified(false);
    try {
      localStorage.setItem(REMEMBER_KEY, rememberMe ? "1" : "0");
    } catch {
      /* ignore */
    }

    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 25_000);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: ac.signal,
        body: JSON.stringify({ email, password, mode, rememberMe }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setError(
          (typeof data.error === "string" && data.error) ||
            `로그인 실패 (${res.status}). 잠시 후 다시 시도해 주세요.`,
        );
        if (data.code === "email_unverified") setUnverified(true);
        setLoading(false);
        return;
      }
      if (data.needsEmailVerification) {
        setMode("login");
        setInfo(
          (typeof data.message === "string" && data.message) ||
            "인증 메일을 보냈습니다. 메일함의 링크를 클릭한 뒤 로그인해 주세요.",
        );
        setLoading(false);
        return;
      }
      clearManualLogoutFlag();
      // Full navigation avoids soft-route races with logout / stale login query.
      const next = resolvePostLoginPath({
        role: (typeof data.role === "string" && data.role) || "user",
        approvalStatus:
          (typeof data.approvalStatus === "string" && data.approvalStatus) ||
          "pending",
        hasBrokerAccount: !!data.hasBrokerAccount,
      });
      window.location.replace(next);
      return; // keep loading until navigation unloads the page
    } catch (err) {
      const aborted =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      setError(
        aborted
          ? "서버 응답이 지연되고 있습니다. 네트워크 확인 후 다시 시도해 주세요."
          : "네트워크 오류로 로그인하지 못했습니다. 다시 시도해 주세요.",
      );
      setLoading(false);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function resendVerification() {
    setLoading(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        setError(
          (typeof data.error === "string" && data.error) || "재발송 실패",
        );
        return;
      }
      setInfo(
        (typeof data.message === "string" && data.message) ||
          "인증 메일을 다시 보냈습니다.",
      );
    } catch {
      setError("네트워크 오류로 재발송에 실패했습니다.");
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
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
            />
          </div>
          {mode === "login" ? (
            <label
              className="flex cursor-pointer items-center gap-2.5 select-none"
              style={{ color: "var(--ink)" }}
            >
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: "var(--gold)" }}
              />
              <span style={{ fontSize: "0.92rem", fontWeight: 600 }}>자동 로그인</span>
              <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                (90일간 로그인 유지)
              </span>
            </label>
          ) : null}
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
