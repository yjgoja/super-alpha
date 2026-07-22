"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { FIXED_MT5_SERVER } from "@/lib/dca";

function friendlyConnectError(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return "계좌 연결 신청에 실패했습니다. 잠시 후 다시 시도하세요.";
  if (
    /fetch failed|network|econnreset|enotfound|etimedout|socket|undici|timeout|503|502/i.test(
      text,
    ) ||
    (/^[A-Za-z0-9\s.,'"_:/\-()]+$/.test(text) && !/[가-힣]/.test(text))
  ) {
    return "연결이 잠시 불안정합니다. 다시 한 번 시도해 주세요.";
  }
  return text;
}

function ConnectForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reapply = params.get("reapply") === "1";
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [checking, setChecking] = useState(true);
  const [approvalPending, setApprovalPending] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/me");
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const me = await res.json().catch(() => ({}));
      if (me.role === "admin") {
        router.replace("/admin");
        return;
      }
      if (me.approvalStatus === "rejected") {
        router.replace("/pending");
        return;
      }
      if (me.approvalStatus && me.approvalStatus !== "approved") {
        setApprovalPending(true);
        setChecking(false);
        return;
      }
      const st = me.account?.status as string | undefined;
      const linked = Boolean(me.account?.metaApiAccountId);
      const canReapply =
        reapply ||
        st === "failed" ||
        st === "pending_registration" ||
        st === "provisioning";
      if (linked && !canReapply) {
        router.replace("/home");
        return;
      }
      if (me.account?.login) setLogin(String(me.account.login).replace(/\D/g, ""));
      setChecking(false);
    })();
  }, [router, reapply]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login,
          password,
          server: FIXED_MT5_SERVER,
          reapply: reapply || true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(friendlyConnectError(data.error));
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/home"), 1500);
    } catch {
      setError("연결이 잠시 불안정합니다. 다시 한 번 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <main className="sa-shell flex min-h-screen items-center justify-center py-10">
        <p className="text-sm text-[var(--muted)]">확인 중…</p>
      </main>
    );
  }

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <form onSubmit={onSubmit} className="sa-panel w-full max-w-lg sa-rise">
        <div className="flex items-center justify-between">
          <Link href="/home" className="font-display text-2xl">
            Super Alpha
          </Link>
          <span className="sa-badge sa-badge-live">연동 신청</span>
        </div>

        <h1 className="mt-6 text-2xl font-semibold">
          {reapply ? "실계좌 다시 연결 신청" : "MT5 실계좌 연결 신청"}
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          계좌·비밀번호를 제출하면 관리자 승인 후 연동됩니다. 비밀번호가 틀리면 승인
          단계에서 거절되니 정확히 입력하세요.
        </p>

        {approvalPending ? (
          <div className="mt-8 rounded-2xl border border-[var(--gold)]/40 bg-[rgba(201,162,39,0.08)] p-5">
            <div className="font-display text-2xl text-[var(--gold)]">관리자 승인 대기</div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              먼저 회원 승인이 필요합니다. 승인 후 실계좌 연결을 신청하세요.
            </p>
            <Link href="/home" className="sa-btn sa-btn-ghost mt-6 inline-flex">
              홈으로
            </Link>
          </div>
        ) : done ? (
          <div className="mt-8 rounded-2xl border border-[var(--accent)]/40 bg-[rgba(200,245,66,0.08)] p-5">
            <div className="font-display text-2xl text-[var(--accent)]">연동 신청 완료</div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              관리자 승인 대기 중입니다. 홈으로 이동합니다…
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
              <label className="sa-label">거래 비밀번호</label>
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
              {loading ? "신청 중…" : "연동 신청하기"}
            </button>
          </div>
        )}
      </form>
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense
      fallback={
        <main className="sa-shell flex min-h-screen items-center justify-center py-10">
          <p className="text-sm text-[var(--muted)]">확인 중…</p>
        </main>
      }
    >
      <ConnectForm />
    </Suspense>
  );
}
