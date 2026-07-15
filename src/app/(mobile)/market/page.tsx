"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { brokerGateRedirect } from "@/lib/post-login";

type Position = {
  id?: string;
  symbol: string;
  direction: string;
  lots: number;
  price: number;
  profit: number;
};

type Account = {
  login: string;
  server: string;
  status: string;
  statusMessage?: string | null;
  botEnabled: boolean;
  balance: number;
  equity: number;
  tpCount: number;
  slCount: number;
  cycleCount: number;
  dailyPnl: number;
  dailyReturnPct: number;
  totalReturnPct: number;
  metaApiAccountId?: string | null;
  livePositions?: Position[];
  syncError?: string | null;
};

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export default function MarketPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const loadFast = useCallback(async () => {
    const res = await fetch("/api/stats");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (res.status === 403) {
      window.location.href = "/pending";
      return;
    }
    const data = await res.json();
    const gate = brokerGateRedirect({
      role: data.role,
      metaApiAccountId: data.account?.metaApiAccountId,
    });
    if (gate) {
      window.location.href = gate;
      return;
    }
    setAccount((prev) => ({
      ...data.account,
      livePositions: prev?.livePositions?.length
        ? prev.livePositions
        : data.account.livePositions || [],
    }));
  }, []);

  const loadLive = useCallback(async () => {
    try {
      const res = await fetch("/api/stats?live=1");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAccount((prev) =>
          prev
            ? {
                ...prev,
                syncError: data.error || "포지션 동기화에 실패했습니다.",
              }
            : prev,
        );
        return;
      }
      if (data.account) setAccount(data.account);
    } catch {
      setAccount((prev) =>
        prev ? { ...prev, syncError: "포지션 동기화 중 네트워크 오류가 발생했습니다." } : prev,
      );
    }
  }, []);

  useEffect(() => {
    loadFast();
    const live = setTimeout(() => {
      loadLive();
    }, 100);
    const id = setInterval(() => {
      loadLive();
      fetch("/api/stats")
        .then((r) => r.json())
        .then((data) => {
          if (data.account?.botEnabled) {
            fetch("/api/stats", { method: "POST" }).catch(() => null);
          }
        })
        .catch(() => null);
    }, 12000);
    return () => {
      clearTimeout(live);
      clearInterval(id);
    };
  }, [loadFast, loadLive]);

  async function closeOne(positionId: string) {
    if (!positionId || busyId) return;
    if (!window.confirm("이 포지션을 시장가로 청산할까요?")) return;
    setBusyId(positionId);
    setMsg("");
    try {
      const res = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error || "청산 실패");
      } else {
        setMsg(data.message || "청산 완료");
        if (data.botEnabled === false) {
          setAccount((a) => (a ? { ...a, botEnabled: false } : a));
        }
        await loadLive();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function closeAll() {
    if (busyId) return;
    const n = account?.livePositions?.length || 0;
    if (!n) return;
    if (!window.confirm(`열린 포지션 ${n}건을 모두 시장가로 청산할까요?`)) return;
    setBusyId("__all__");
    setMsg("");
    try {
      const res = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error || "전체 청산 실패");
      } else {
        setMsg(data.message || "전체 청산 완료");
        if (data.botEnabled === false) {
          setAccount((a) => (a ? { ...a, botEnabled: false } : a));
        }
        await loadLive();
      }
    } finally {
      setBusyId(null);
    }
  }

  if (!account) {
    return (
      <>
        <header className="m-topbar">
          <h1>마켓</h1>
        </header>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>불러오는 중…</p>
      </>
    );
  }

  const pnlClass = account.dailyPnl >= 0 ? "m-pnl-pos" : "m-pnl-neg";
  const floating = (account.livePositions || []).reduce((s, p) => s + (p.profit || 0), 0);
  const positions = account.livePositions || [];

  return (
    <>
      <header className="m-topbar">
        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>거래정보</div>
          <h1>마켓</h1>
        </div>
        <span
          className={`sa-badge ${account.botEnabled ? "sa-badge-live" : ""}`}
          style={{ marginLeft: "auto" }}
        >
          {account.botEnabled ? "봇 실행중" : "봇 정지"}
        </span>
      </header>

      <section className="m-card sa-rise" style={{ marginBottom: "0.85rem" }}>
        <div style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
          계좌 {account.login}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
            marginTop: "0.85rem",
          }}
        >
          <div className="sa-metric">
            <span>잔고</span>
            <strong>${fmt(account.balance)}</strong>
          </div>
          <div className="sa-metric">
            <span>평가금액</span>
            <strong>${fmt(account.equity)}</strong>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.65rem",
            marginTop: "0.85rem",
          }}
        >
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>실시간 손익</div>
            <div
              className={floating >= 0 ? "m-pnl-pos" : "m-pnl-neg"}
              style={{ marginTop: "0.2rem", fontWeight: 650 }}
            >
              {floating >= 0 ? "+" : ""}
              {fmt(floating)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>오늘 실현</div>
            <div className={pnlClass} style={{ marginTop: "0.2rem", fontWeight: 650 }}>
              {account.dailyPnl >= 0 ? "+" : ""}
              {fmt(account.dailyPnl)}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "0.65rem",
            marginTop: "1rem",
            paddingTop: "0.9rem",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>익절 횟수</div>
            <div style={{ marginTop: "0.2rem", fontWeight: 650 }}>{account.tpCount}</div>
            <div style={{ fontSize: "0.65rem", color: "var(--muted)", marginTop: "0.15rem" }}>
              목표수익 달성
            </div>
          </div>
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>손절 횟수</div>
            <div style={{ marginTop: "0.2rem", fontWeight: 650 }}>{account.slCount}</div>
          </div>
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>완료 라운드</div>
            <div style={{ marginTop: "0.2rem", fontWeight: 650 }}>{account.cycleCount}</div>
            <div style={{ fontSize: "0.65rem", color: "var(--muted)", marginTop: "0.15rem" }}>
              진입→청산 1회
            </div>
          </div>
        </div>
        {account.statusMessage && (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            {account.statusMessage}
          </p>
        )}
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.75rem",
          marginBottom: "0.85rem",
        }}
      >
        <Link href="/bot" className="m-card" style={{ textAlign: "center", padding: "1.1rem" }}>
          <div style={{ fontWeight: 650 }}>봇 설정</div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            종목 · 전략
          </div>
        </Link>
        <Link href="/home" className="m-card" style={{ textAlign: "center", padding: "1.1rem" }}>
          <div style={{ fontWeight: 650 }}>트레이딩 PNL</div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            최근 · 누적
          </div>
        </Link>
      </div>

      <section className="m-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem" }}>보유 포지션</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{positions.length}건</span>
            {positions.length > 0 && (
              <button
                type="button"
                className="sa-btn sa-btn-ghost"
                style={{
                  padding: "0.35rem 0.65rem",
                  fontSize: "0.75rem",
                  color: "var(--danger)",
                  borderRadius: 10,
                }}
                disabled={!!busyId}
                onClick={closeAll}
              >
                {busyId === "__all__" ? "청산중…" : "전체 청산"}
              </button>
            )}
          </div>
        </div>

        {msg && (
          <p style={{ margin: "0.65rem 0 0", fontSize: "0.82rem", color: "var(--gold)" }}>{msg}</p>
        )}

        {account.syncError && (
          <p style={{ margin: "0.65rem 0 0", fontSize: "0.82rem", color: "var(--danger)" }}>
            {account.syncError}
          </p>
        )}

        {positions.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "0.88rem", margin: "1rem 0 0.25rem" }}>
            {account.syncError
              ? "실시간 포지션을 불러오지 못했습니다. 잠시 후 다시 시도하세요."
              : "열린 포지션이 없습니다."}
          </p>
        ) : (
          <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.55rem" }}>
            {positions.map((p, i) => (
              <div
                key={p.id || `${p.symbol}-${i}`}
                style={{
                  padding: "0.65rem 0",
                  borderTop: i ? "1px solid rgba(255,255,255,0.05)" : undefined,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{p.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
                    <div className={p.profit >= 0 ? "m-pnl-pos" : "m-pnl-neg"}>
                      {p.profit >= 0 ? "+" : ""}
                      {fmt(p.profit)}
                    </div>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{
                        padding: "0.3rem 0.55rem",
                        fontSize: "0.72rem",
                        color: "var(--danger)",
                        borderRadius: 8,
                        flexShrink: 0,
                      }}
                      disabled={!p.id || !!busyId}
                      onClick={() => p.id && closeOne(p.id)}
                    >
                      {busyId === p.id ? "…" : "청산"}
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: "0.4rem",
                    marginTop: "0.45rem",
                    fontSize: "0.78rem",
                    color: "var(--muted)",
                  }}
                >
                  <div>
                    방향{" "}
                    <span style={{ color: "var(--ink)", fontWeight: 600 }}>{p.direction}</span>
                  </div>
                  <div>
                    수량{" "}
                    <span style={{ color: "var(--ink)", fontWeight: 600 }}>{p.lots}</span>
                  </div>
                  <div>
                    진입{" "}
                    <span style={{ color: "var(--ink)", fontWeight: 600 }}>{fmt(p.price, 5)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
