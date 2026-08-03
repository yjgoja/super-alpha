"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountLinkBadge } from "@/components/ConnectPrompt";
import { SharePnlSheet } from "@/components/SharePnlSheet";
import { subscribeLive } from "@/lib/live-bus";
import { padDailyPnl, type DayPnl } from "@/lib/pnl-period";

type CloseRow = {
  id: string;
  symbol: string;
  side: string;
  lots: number;
  pnl: number;
  kind: string;
  createdAt: string;
};

function fmt(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(n: number) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsdSigned(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  return `${sign}$${fmt(n)}`;
}

function relTimeKo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return `${d}일 전`;
}

/** Home — today PnL + horizontal 5-day chart + closes */
export default function HomePage() {
  const [days, setDays] = useState<DayPnl[]>([]);
  const [closes, setCloses] = useState<CloseRow[]>([]);
  const [equity, setEquity] = useState(0);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [dailyReturnPct, setDailyReturnPct] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasAccount, setHasAccount] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [activeAccountLabel, setActiveAccountLabel] = useState("");
  const [accountCount, setAccountCount] = useState(0);
  const [linked, setLinked] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<string>("approved");
  const [accountStatus, setAccountStatus] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let linkedNow = false;

    function applyPnl(pnl: {
      days?: DayPnl[];
      account?: unknown;
      closes?: CloseRow[];
    }) {
      const rawDays: DayPnl[] = Array.isArray(pnl.days) ? pnl.days : [];
      const padded =
        rawDays.length === 0 && !pnl.account && !linkedNow
          ? []
          : padDailyPnl(rawDays);
      setDays(padded);
      if (padded.length) {
        setSelectedDay((prev) => prev || padded[padded.length - 1]?.date || null);
      }
      setCloses(Array.isArray(pnl.closes) ? pnl.closes : []);
      if (pnl.account || rawDays.length > 0 || linkedNow) setHasAccount(true);
    }

    function applyStats(stats: {
      account?: {
        equity?: number;
        dailyPnl?: number;
        dailyReturnPct?: number;
        status?: string;
        metaApiAccountId?: string | null;
      } | null;
    }) {
      if (!stats.account) return;
      setEquity(stats.account.equity || 0);
      setDailyPnl(stats.account.dailyPnl || 0);
      setDailyReturnPct(Number(stats.account.dailyReturnPct) || 0);
      setAccountStatus(stats.account.status || null);
      setHasAccount(true);
      if (stats.account.metaApiAccountId) linkedNow = true;
    }

    async function loadHero() {
      try {
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
        setActiveAccountLabel(
          me.account?.label ||
            me.account?.displayName ||
            (me.account?.login ? `MT5 ${me.account.login}` : "") ||
            (stats.account?.login ? `MT5 ${stats.account.login}` : ""),
        );
        setAccountCount(Array.isArray(me.accounts) ? me.accounts.length : me.account ? 1 : 0);
        linkedNow = Boolean(me.linked ?? stats.account?.metaApiAccountId);
        setLinked(linkedNow);
        setApprovalStatus(me.approvalStatus || "pending");
        if (me.account?.status && !stats.account?.status) {
          setAccountStatus(me.account.status);
        }
      } finally {
        if (!stopped) setLoading(false);
      }
    }

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

    async function refreshPnlOnce() {
      if (stopped || !linkedNow) return;
      try {
        const key = "sa_pnl_refresh_at";
        const prev = Number(sessionStorage.getItem(key) || 0);
        if (Date.now() - prev < 15 * 60_000) return;
        sessionStorage.setItem(key, String(Date.now()));
        const res = await fetch("/api/pnl?refresh=1", { cache: "no-store" });
        if (!res.ok) return;
        const pnl = await res.json().catch(() => ({}));
        if (!stopped) applyPnl(pnl);
      } catch {
        /* ignore */
      }
    }

    (async () => {
      await Promise.all([loadHero(), loadPnlFast()]);
      if (stopped) return;
      if (linkedNow) {
        setDays((prev) => (prev.length === 0 ? padDailyPnl([]) : prev));
        setHasAccount(true);
        void refreshPnlOnce();
      }
    })();

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

  const pnlPos = dailyPnl >= 0;
  const chartDays = useMemo(() => days.slice(-5), [days]);
  const maxAbs = Math.max(1, ...chartDays.map((d) => Math.abs(d.pnl)));
  const selected =
    chartDays.find((d) => d.date === selectedDay) || chartDays[chartDays.length - 1];

  return (
    <>
      <header className="m-topbar sa-home-top">
        <div className="sa-home-brand">
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
                "수익 인증"
              )}
            </div>
          </div>
        </div>
        <div
          className={`sa-home-stamp${linked ? " is-on" : ""}`}
          title={linked ? "실계좌 연동됨" : "실계좌 미연동"}
        >
          {linked ? "실계좌 연동" : "미연동"}
        </div>
      </header>

      {activeAccountLabel ? (
        <Link
          href="/manage"
          className="m-card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.65rem",
            padding: "0.7rem 0.9rem",
          }}
        >
          <div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>사용 중 계좌</div>
            <div style={{ fontWeight: 700, marginTop: "0.15rem" }}>
              {activeAccountLabel}
              {accountCount > 1 ? (
                <span style={{ marginLeft: "0.4rem", fontSize: "0.75rem", color: "var(--gold)" }}>
                  {accountCount}개
                </span>
              ) : null}
            </div>
          </div>
          <span style={{ color: "var(--gold)", fontSize: "0.85rem" }}>계좌 관리 ›</span>
        </Link>
      ) : null}

      <section className="sa-home-today sa-rise">
        <div className="sa-home-today-main">
          <div className="sa-home-equity-block">
            <div className="sa-home-k">평가금액</div>
            <div className="sa-home-equity-lg">${fmt(equity)}</div>
          </div>
          <button
            type="button"
            className="sa-home-share-mini"
            disabled={loading || !hasAccount}
            onClick={() => setShareOpen(true)}
          >
            공유
          </button>
        </div>
        <div className="sa-home-today-metrics">
          <div>
            <div className="sa-home-k">오늘</div>
            <div className={pnlPos ? "m-pnl-pos sa-home-pct" : "m-pnl-neg sa-home-pct"}>
              {fmtPct(dailyReturnPct)}
            </div>
            <div className={pnlPos ? "m-pnl-pos sa-home-usd" : "m-pnl-neg sa-home-usd"}>
              {fmtUsdSigned(dailyPnl)}
            </div>
          </div>
        </div>
      </section>

      <SharePnlSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        today={{ returnPct: dailyReturnPct, pnlUsd: dailyPnl }}
      />

      <section className="sa-home-hchart m-card">
        <h2 className="sa-home-sec-title">최근 5일 손익</h2>
        {loading ? (
          <p className="sa-home-empty">불러오는 중…</p>
        ) : chartDays.length === 0 ? (
          <p className="sa-home-empty">최근 거래 데이터가 없습니다.</p>
        ) : (
          <div className="sa-home-hbar-list">
            {chartDays.map((d) => {
              const empty = d.trades === 0 && d.pnl === 0;
              const on = d.date === (selected?.date || selectedDay);
              const pct = empty ? 0 : Math.max(8, (Math.abs(d.pnl) / maxAbs) * 100);
              const pos = d.pnl > 0;
              const neg = d.pnl < 0;
              return (
                <button
                  key={d.date}
                  type="button"
                  className={`sa-home-hbar-row${on ? " is-on" : ""}`}
                  onClick={() => setSelectedDay(d.date)}
                >
                  <span className="sa-home-hbar-date">{d.date.slice(5)}</span>
                  <span className="sa-home-hbar-track">
                    {!empty && (
                      <span
                        className={`sa-home-hbar-fill${neg ? " is-neg" : " is-pos"}`}
                        style={{ width: `${pct}%` }}
                      />
                    )}
                  </span>
                  <span
                    className={
                      empty
                        ? "sa-home-day-dash"
                        : pos
                          ? "m-pnl-pos"
                          : neg
                            ? "m-pnl-neg"
                            : "sa-home-day-dash"
                    }
                  >
                    {empty ? "—" : fmtUsdSigned(d.pnl)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selected && (selected.trades > 0 || selected.pnl !== 0) && (
          <p className="sa-home-day-hint">
            {selected.date}
            {selected.trades > 0 ? ` · 청산 ${selected.trades}건` : ""} ·{" "}
            <span className={selected.pnl >= 0 ? "m-pnl-pos" : "m-pnl-neg"}>
              {fmtUsdSigned(selected.pnl)}
            </span>
          </p>
        )}
      </section>

      <section className="sa-home-closes">
        <h2 className="sa-home-sec-title">청산 기록</h2>
        <div className="sa-home-close-list">
          {closes.length === 0 && !loading && (
            <p className="sa-home-empty">청산 기록이 없습니다.</p>
          )}
          {closes.map((f) => {
            const isTp = f.kind === "TP";
            const pos = f.pnl >= 0;
            return (
              <div key={f.id} className="sa-home-close-row">
                <span className={`sa-home-close-badge${isTp ? " is-tp" : " is-sl"}`}>
                  {isTp ? "TP" : "SL"}
                </span>
                <div className="sa-home-close-main">
                  <div className="sa-home-close-sym">{f.symbol}</div>
                  <div className="sa-home-close-meta">
                    {f.side} {f.lots.toFixed(2)} · {relTimeKo(f.createdAt)}
                  </div>
                </div>
                <div className={pos ? "m-pnl-pos" : "m-pnl-neg"}>
                  {fmtUsdSigned(f.pnl)}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
