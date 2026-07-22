"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountLinkBadge } from "@/components/ConnectPrompt";

export default function MyPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [login, setLogin] = useState("");
  const [linked, setLinked] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<string>("approved");
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [totalPnl, setTotalPnl] = useState(0);
  const [totalTrades, setTotalTrades] = useState(0);

  useEffect(() => {
    (async () => {
      const [meRes, pnlRes] = await Promise.all([fetch("/api/me"), fetch("/api/pnl")]);
      if (meRes.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (meRes.status === 403) {
        window.location.href = "/pending";
        return;
      }
      const me = await meRes.json().catch(() => ({}));
      const pnl = await pnlRes.json().catch(() => ({}));
      setName(me.name || "");
      setEmail(me.email || "");
      setLogin(pnl.account?.login || me.account?.login || "");
      setLinked(Boolean(me.linked));
      setApprovalStatus(me.approvalStatus || "pending");
      setAccountStatus(me.account?.status || null);
      setTotalPnl(pnl.totalPnl || 0);
      setTotalTrades(pnl.totalTrades || 0);
    })();
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <>
      <header className="m-topbar">
        <h1>마이페이지</h1>
      </header>

      <section className="m-card" style={{ marginBottom: "0.85rem" }}>
        <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>계정</div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", marginTop: "0.3rem" }}>
          {name || email || "—"}
          {(name || email) && (
            <AccountLinkBadge
              linked={linked}
              approvalStatus={approvalStatus}
              accountStatus={accountStatus}
            />
          )}
        </div>
        {email && name && (
          <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            {email}
          </div>
        )}
        {login && (
          <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            MT5 {login}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.75rem",
            marginTop: "1rem",
            paddingTop: "0.85rem",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>누적 손익</div>
            <div
              className={totalPnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}
              style={{ marginTop: "0.25rem" }}
            >
              {totalPnl >= 0 ? "+" : ""}
              {totalPnl.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>거래 건수</div>
            <div style={{ fontWeight: 650, marginTop: "0.25rem" }}>{totalTrades} 건</div>
          </div>
        </div>
      </section>

      <Link
        href="/home"
        className="m-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.55rem",
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>트레이딩 PNL</div>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
            홈 · 최근 손익
          </div>
        </div>
        <span style={{ color: "var(--gold)", fontSize: "1.2rem" }}>›</span>
      </Link>

      <Link
        href="/bot"
        className="m-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.55rem",
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>종목 · 전략 설정</div>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
            동시 매매 · 종목별 로직
          </div>
        </div>
        <span style={{ color: "var(--gold)", fontSize: "1.2rem" }}>›</span>
      </Link>

      <Link
        href="/manage"
        className="m-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.55rem",
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>계좌 · 클라우드 관리</div>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
            연동 · 비용 절감
          </div>
        </div>
        <span style={{ color: "var(--gold)", fontSize: "1.2rem" }}>›</span>
      </Link>

      <button
        type="button"
        className="m-card"
        style={{
          textAlign: "left",
          cursor: "pointer",
          color: "var(--danger)",
          width: "100%",
        }}
        onClick={logout}
      >
        <div style={{ fontWeight: 650 }}>로그아웃</div>
      </button>
    </>
  );
}
