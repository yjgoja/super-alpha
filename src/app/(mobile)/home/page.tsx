"use client";

import { useEffect, useMemo, useState } from "react";
import { AccountLinkBadge } from "@/components/ConnectPrompt";
import { SharePnlSheet } from "@/components/SharePnlSheet";
import { subscribeLive } from "@/lib/live-bus";
import { padDailyPnl, withCumulative, type DayPnl } from "@/lib/pnl-period";

function fmt(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** SuperMeta-style Home: Trading PNL chart + period table */
export default function HomePage() {
  const [mode, setMode] = useState<"daily" | "cum">("daily");
  const [days, setDays] = useState<DayPnl[]>([]);
  const [totalPnl, setTotalPnl] = useState(0);
  const [totalTrades, setTotalTrades] = useState(0);
  const [equity, setEquity] = useState(0);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [dailyReturnPct, setDailyReturnPct] = useState(0);
  const [totalReturnPct, setTotalReturnPct] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [tip, setTip] = useState<{ date: string; pnl: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasAccount, setHasAccount] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [linked, setLinked] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<string>("approved");
  const [accountStatus, setAccountStatus] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let linkedNow = false;

    function applyPnl(pnl: {
      days?: DayPnl[];
      account?: unknown;
      totalPnl?: number;
      totalTrades?: number;
    }) {
      const rawDays: DayPnl[] = Array.isArray(pnl.days) ? pnl.days : [];
      const padded =
        rawDays.length === 0 && !pnl.account ? [] : padDailyPnl(rawDays);
      setDays(padded);
      setTotalPnl(pnl.totalPnl || 0);
      setTotalTrades(pnl.totalTrades || 0);
      if (pnl.account || rawDays.length > 0) setHasAccount(true);
    }

    function applyStats(stats: {
      account?: {
        equity?: number;
        dailyPnl?: number;
        dailyReturnPct?: number;
        totalReturnPct?: number;
        status?: string;
        metaApiAccountId?: string | null;
      } | null;
    }) {
      if (!stats.account) return;
      setEquity(stats.account.equity || 0);
      setDailyPnl(stats.account.dailyPnl || 0);
      setDailyReturnPct(Number(stats.account.dailyReturnPct) || 0);
      setTotalReturnPct(Number(stats.account.totalReturnPct) || 0);
      setAccountStatus(stats.account.status || null);
      setHasAccount(true);
      if (stats.account.metaApiAccountId) linkedNow = true;
    }

    /** 1) Hero first — DB only (me + summary stats) */
    async function loadHero() {
      const [statsRes, meRes] = await Promise.all([
        fetch("/api/stats?summary=1", { cache: "no-store" }),
        fetch("/api/me", { cache: "no-store" }),
      ]);
      if (statsRes.status === 401 || meRes.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (meRes.status === 403) {
        window.location.href = "/pending";
        return;
      }
      const stats = await statsRes.json().catch(() => ({}));
      const me = await meRes.json().catch(() => ({}));
      if (stopped) return;
      applyStats(stats);
      setDisplayName(me.name || me.email || "");
      linkedNow = Boolean(me.linked ?? stats.account?.metaApiAccountId);
      setLinked(linkedNow);
      setApprovalStatus(me.approvalStatus || "pending");
      if (me.account?.status && !stats.account?.status) {
        setAccountStatus(me.account.status);
      }
      setLoading(false);
    }

    /** 2) Chart from DB (fast) */
    async function loadPnlFast() {
      try {
        const res = await fetch("/api/pnl", { cache: "no-store" });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        const pnl = await res.json().catch(() => ({}));
        if (!stopped) applyPnl(pnl);
      } catch {
        /* ignore */
      }
    }

    /** One-shot chart/history sync from MetaAPI (background) */
    async function refreshPnlOnce() {
      if (stopped || !linkedNow) return;
      try {
        const res = await fetch("/api/pnl?refresh=1", { cache: "no-store" });
        if (!res.ok) return;
        const pnl = await res.json().catch(() => ({}));
        if (!stopped) applyPnl(pnl);
      } catch {
        /* ignore */
      }
    }

    (async () => {
      await loadHero();
      if (stopped) return;
      await loadPnlFast();
      if (stopped) return;
      if (linkedNow) refreshPnlOnce();
    })();

    // Live equity/PnL from BotHeartbeat (SSE + single MetaAPI poller)
    const unsub = subscribeLive((detail) => {
      if (stopped || !detail.account) return;
      applyStats({ account: detail.account });
      linkedNow = Boolean(detail.account.metaApiAccountId);
      setLinked(linkedNow);
    });

    return () => {
      stopped = true;
      unsub();
    };
  }, []);

  const cumulative = useMemo(() => withCumulative(days), [days]);

  const chart = useMemo(() => {
    if (mode === "daily") {
      return days.map((d) => ({ date: d.date, value: d.pnl, trades: d.trades }));
    }
    return cumulative.map((d) => ({ date: d.date, value: d.pnl, trades: d.trades }));
  }, [mode, days, cumulative]);

  const maxAbs = Math.max(1, ...chart.map((c) => Math.abs(c.value)));
  const yMax = Math.ceil(maxAbs * 10) / 10;
  const yTicks = [yMax, yMax * (2 / 3), yMax / 3, 0].map((v) =>
    Math.round(v * 10) / 10,
  );
  const tableRows =
    mode === "daily"
      ? days
      : cumulative.map((c) => ({
          date: c.date,
          pnl: c.pnl,
          trades: c.trades,
        }));

  function fmtAxis(n: number) {
    return n.toFixed(1);
  }

  const showEmpty = !loading && (!hasAccount || days.length === 0);

  return (
    <>
      <header className="m-topbar sm-home-top">
        <div className="sm-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/sa-logo.png"
            alt="Super Alpha"
            className="sm-brand-logo"
          />
          <div>
            <div className="sm-brand-name">SUPER ALPHA</div>
            <div className="sm-brand-sub">
              {displayName ? (
                <>
                  {displayName}
                  <AccountLinkBadge
                    linked={linked}
                    approvalStatus={approvalStatus}
                    accountStatus={accountStatus}
                  />
                </>
              ) : (
                "트레이딩 PNL"
              )}
            </div>
          </div>
        </div>
      </header>

      <section className="m-card sm-hero sa-rise" style={{ marginBottom: "0.85rem" }}>
        <div className="sm-hero-top">
          <div>
            <div className="sm-hero-label">평가금액</div>
            <div className="sm-hero-equity">${fmt(equity)}</div>
          </div>
          <button
            type="button"
            className="sm-share-btn"
            disabled={loading || !hasAccount}
            onClick={() => setShareOpen(true)}
          >
            공유
          </button>
        </div>
        <div className="sm-hero-row">
          <div>
            <div className="sm-hero-k">오늘 손익</div>
            <div className={dailyPnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}>
              {dailyPnl >= 0 ? "+" : ""}
              {fmt(dailyPnl)}
            </div>
          </div>
          <div>
            <div className="sm-hero-k">누적 손익</div>
            <div className={totalPnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}>
              {totalPnl >= 0 ? "+" : ""}
              {fmt(totalPnl)}
            </div>
          </div>
          <div>
            <div className="sm-hero-k">거래 건수</div>
            <div style={{ fontWeight: 700 }}>{totalTrades} 건</div>
          </div>
        </div>
      </section>

      <SharePnlSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        today={{ returnPct: dailyReturnPct, pnlUsd: dailyPnl }}
      />

      <div className="m-seg" style={{ marginBottom: "0.85rem" }}>
        <button
          type="button"
          className={mode === "daily" ? "is-on" : ""}
          onClick={() => {
            setMode("daily");
            setTip(null);
          }}
        >
          일별 손익
        </button>
        <button
          type="button"
          className={mode === "cum" ? "is-on" : ""}
          onClick={() => {
            setMode("cum");
            setTip(null);
          }}
        >
          누적 손익
        </button>
      </div>

      <section className="m-card" style={{ marginBottom: "0.85rem", minHeight: 210 }}>
        {loading ? (
          <p style={{ color: "var(--muted)", textAlign: "center", padding: "3rem 0" }}>
            불러오는 중…
          </p>
        ) : showEmpty ? (
          <p
            style={{
              color: "var(--muted)",
              textAlign: "center",
              padding: "3rem 0",
              fontSize: "0.9rem",
            }}
          >
            최근 거래 데이터가 없습니다.
          </p>
        ) : (
          <>
            {tip && (
              <div className="sm-chart-tip">
                <div style={{ color: "var(--muted)" }}>날짜 {tip.date}</div>
                <div
                  className={tip.pnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}
                  style={{ marginTop: "0.15rem" }}
                >
                  손익 {tip.pnl >= 0 ? "+" : ""}
                  {fmt(tip.pnl)} USD
                </div>
              </div>
            )}
            <div className="m-chart-frame">
              <div className="m-chart-yaxis" aria-hidden>
                {yTicks.map((t, i) => (
                  <span key={`${t}-${i}`}>{fmtAxis(t)}</span>
                ))}
              </div>
              <div className="m-chart-plot">
                <div className="m-chart-grid" aria-hidden>
                  {yTicks.map((t, i) => (
                    <div key={`g-${t}-${i}`} className="m-chart-grid-line" />
                  ))}
                </div>
                <div className="m-chart">
                  {chart.map((c) => {
                    const isZero = c.value === 0;
                    const h = isZero ? 6 : Math.max(8, (Math.abs(c.value) / yMax) * 132);
                    return (
                      <button
                        key={c.date}
                        type="button"
                        className="m-chart-bar-wrap"
                        style={{
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                          color: "inherit",
                          padding: 0,
                        }}
                        onClick={() => setTip({ date: c.date, pnl: c.value })}
                      >
                        <div
                          className={`m-chart-bar${c.value < 0 ? " is-neg" : ""}${isZero ? " is-zero" : ""}`}
                          style={{ height: h }}
                          title={`${c.date}: ${c.value}`}
                        />
                        <span className="m-chart-label">{c.date.slice(5)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.55rem" }}>기간별 손익</h2>
        <div className="m-card" style={{ padding: "0.35rem 0.65rem 0.15rem" }}>
          <table className="m-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>{mode === "daily" ? "손익" : "누적"}</th>
                <th>거래 건수</th>
              </tr>
            </thead>
            <tbody>
              {[...tableRows].reverse().map((row) => (
                <tr key={row.date}>
                  <td style={{ color: "#aeb8c6" }}>{row.date}</td>
                  <td className={row.pnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}>
                    {row.pnl >= 0 ? "+" : ""}
                    {fmt(row.pnl)}
                  </td>
                  <td>{row.trades}</td>
                </tr>
              ))}
              {!loading && tableRows.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--muted)", padding: "1.5rem" }}>
                    데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
