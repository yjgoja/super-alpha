"use client";

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

function syncLabel(syncAgeSec: number | null) {
  if (syncAgeSec == null) return "실체결 기준";
  if (syncAgeSec < 5) return "실체결 기준 · 방금";
  if (syncAgeSec < 60) return `실체결 기준 · 지연 ${syncAgeSec}초`;
  const m = Math.floor(syncAgeSec / 60);
  return `실체결 기준 · 지연 ${m}분`;
}

function todayKeyLocal() {
  // Display date for cert card — Seoul-ish via toLocale (UI only)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Home — Concept B: 수익 인증 장부 (green/red PnL, SA logo) */
export default function HomePage() {
  const [days, setDays] = useState<DayPnl[]>([]);
  const [closes, setCloses] = useState<CloseRow[]>([]);
  const [todayTp, setTodayTp] = useState(0);
  const [todaySl, setTodaySl] = useState(0);
  const [equity, setEquity] = useState(0);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [dailyReturnPct, setDailyReturnPct] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasAccount, setHasAccount] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [linked, setLinked] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<string>("approved");
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [syncAgeSec, setSyncAgeSec] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let linkedNow = false;

    function applyPnl(pnl: {
      days?: DayPnl[];
      account?: unknown;
      closes?: CloseRow[];
      todayTp?: number;
      todaySl?: number;
      lastSyncAt?: string | null;
    }) {
      const rawDays: DayPnl[] = Array.isArray(pnl.days) ? pnl.days : [];
      // Linked / known accounts always get a padded chart (zeros OK) so home never looks blank.
      const padded =
        rawDays.length === 0 && !pnl.account && !linkedNow
          ? []
          : padDailyPnl(rawDays);
      setDays(padded);
      if (padded.length) {
        setSelectedDay((prev) => prev || padded[padded.length - 1]?.date || null);
      }
      setCloses(Array.isArray(pnl.closes) ? pnl.closes : []);
      setTodayTp(Number(pnl.todayTp) || 0);
      setTodaySl(Number(pnl.todaySl) || 0);
      if (pnl.lastSyncAt) {
        const age = Math.max(
          0,
          Math.floor((Date.now() - Date.parse(pnl.lastSyncAt)) / 1000),
        );
        setSyncAgeSec(age);
      }
      if (pnl.account || rawDays.length > 0 || linkedNow) setHasAccount(true);
    }

    function applyStats(stats: {
      account?: {
        equity?: number;
        dailyPnl?: number;
        dailyReturnPct?: number;
        status?: string;
        metaApiAccountId?: string | null;
        syncAgeSec?: number | null;
      } | null;
    }) {
      if (!stats.account) return;
      setEquity(stats.account.equity || 0);
      setDailyPnl(stats.account.dailyPnl || 0);
      setDailyReturnPct(Number(stats.account.dailyReturnPct) || 0);
      setAccountStatus(stats.account.status || null);
      if (typeof stats.account.syncAgeSec === "number") {
        setSyncAgeSec(stats.account.syncAgeSec);
      }
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
      // If PnL API lagged/failed but account is linked, still show zero chart frame
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

  const todayCloses = todayTp + todaySl;
  const winRate = todayCloses > 0 ? (todayTp / todayCloses) * 100 : null;
  const pnlPos = dailyPnl >= 0;
  const certDate = todayKeyLocal().replace(/-/g, ".");

  const ring = useMemo(() => {
    const r = 36;
    const c = 2 * Math.PI * r;
    const pct = winRate == null ? 0 : Math.min(100, Math.max(0, winRate));
    return { r, c, offset: c * (1 - pct / 100), pct };
  }, [winRate]);

  const selected = days.find((d) => d.date === selectedDay) || days[days.length - 1];

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

      <section className="sa-home-today sa-rise">
        <div className="sa-home-today-left">
          <div className="sa-home-k">오늘</div>
          <div className={pnlPos ? "m-pnl-pos sa-home-pct" : "m-pnl-neg sa-home-pct"}>
            {fmtPct(dailyReturnPct)}
          </div>
          <div className={pnlPos ? "m-pnl-pos sa-home-usd" : "m-pnl-neg sa-home-usd"}>
            {fmtUsdSigned(dailyPnl)}
          </div>
        </div>
        <div className="sa-home-ring-wrap" aria-label="오늘 승률">
          <svg className="sa-home-ring" viewBox="0 0 88 88" width="88" height="88">
            <circle
              cx="44"
              cy="44"
              r={ring.r}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="7"
            />
            <circle
              cx="44"
              cy="44"
              r={ring.r}
              fill="none"
              stroke="var(--gold)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={ring.c}
              strokeDashoffset={ring.offset}
              transform="rotate(-90 44 44)"
            />
          </svg>
          <div className="sa-home-ring-label">
            <div className="sa-home-ring-title">승률</div>
            <div className="sa-home-ring-val">
              {winRate == null ? "—" : `${Math.round(winRate)}%`}
            </div>
            <div className="sa-home-ring-sub">
              {todayCloses > 0 ? `${todayTp} / ${todayCloses}` : "청산 없음"}
            </div>
          </div>
          <div className="sa-home-equity">평가 ${fmt(equity)}</div>
        </div>
      </section>

      <button
        type="button"
        className="sa-home-cert"
        disabled={loading || !hasAccount}
        onClick={() => setShareOpen(true)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/sa-logo.png"
          alt=""
          className="sa-home-cert-mark"
          aria-hidden
        />
        <div className="sa-home-cert-body">
          <div className="sa-home-cert-eyebrow">수익 인증 카드</div>
          <div className="sa-home-cert-date">{certDate}</div>
          <div className={pnlPos ? "m-pnl-pos sa-home-cert-pct" : "m-pnl-neg sa-home-cert-pct"}>
            {fmtPct(dailyReturnPct)}
          </div>
          <div className={pnlPos ? "m-pnl-pos sa-home-cert-usd" : "m-pnl-neg sa-home-cert-usd"}>
            {fmtUsdSigned(dailyPnl)}
          </div>
        </div>
        <span className="sa-home-cert-share">공유하기</span>
      </button>

      <SharePnlSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        today={{ returnPct: dailyReturnPct, pnlUsd: dailyPnl }}
      />

      <section className="sa-home-days">
        <h2 className="sa-home-sec-title">일자별 흐름</h2>
        {loading ? (
          <p className="sa-home-empty">불러오는 중…</p>
        ) : days.length === 0 ? (
          <p className="sa-home-empty">최근 거래 데이터가 없습니다.</p>
        ) : (
          <div className="sa-home-day-scroll">
            {days.map((d) => {
              const empty = d.trades === 0 && d.pnl === 0;
              const on = d.date === (selected?.date || selectedDay);
              const pos = d.pnl > 0;
              const neg = d.pnl < 0;
              return (
                <button
                  key={d.date}
                  type="button"
                  className={`sa-home-day-tile${on ? " is-on" : ""}`}
                  onClick={() => setSelectedDay(d.date)}
                >
                  <span className="sa-home-day-mmdd">{d.date.slice(5)}</span>
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
                    {empty
                      ? "—"
                      : `${d.pnl > 0 ? "+" : ""}$${fmt(d.pnl)}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selected && selected.trades > 0 && (
          <p className="sa-home-day-hint">
            {selected.date} · 청산 {selected.trades}건 ·{" "}
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
        <p className="sa-home-footnote">MetaAPI {syncLabel(syncAgeSec)}</p>
      </section>
    </>
  );
}
