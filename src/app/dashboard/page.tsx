"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type AccountPayload = {
  id: string;
  login: string;
  server: string;
  mode: string;
  status: string;
  syncToken?: string | null;
  lastSyncAt?: string | null;
  syncAgeSec?: number | null;
  botEnabled: boolean;
  balance: number;
  equity: number;
  startingBalance: number;
  tpCount: number;
  slCount: number;
  cycleCount: number;
  totalReturnPct: number;
  dailyReturnPct: number;
  dailyPnl: number;
  config: {
    baseLots: number;
    profitTarget: number;
    maxDcaLevel: number;
    devScale: number;
    reenterAfterTp: boolean;
    reenterAfterSl: boolean;
    enableFinalSl: boolean;
    finalSlExtraPct: number;
  } | null;
  baskets: {
    id: string;
    symbol: string;
    direction: string;
    filledLevel: number;
    firstEntryPrice: number;
    unrealizedPnl: number;
    legs: { lots: number; level: number; price: number }[];
  }[];
  fills: {
    id: string;
    symbol: string;
    side: string;
    lots: number;
    price: number;
    pnl: number;
    kind: string;
    note: string | null;
    createdAt: string;
  }[];
  snapshots: { equity: number; createdAt: string }[];
};

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function Spark({ points }: { points: number[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * 100;
        const y = 100 - ((p - min) / span) * 100;
        return `${i === 0 ? "M" : "L"}${x},${y}`;
      })
      .join(" ");
  }, [points]);

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-24 w-full">
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function DashboardPage() {
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/stats");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await res.json();
    setAccount(data.account);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const tick = setInterval(async () => {
      // paper engine only when not live
      await fetch("/api/stats", { method: "POST" }).catch(() => null);
      await load();
    }, 5000);
    return () => clearInterval(tick);
  }, [load]);

  async function toggleBot() {
    if (!account) return;
    setBusy(true);
    await fetch("/api/bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !account.botEnabled }),
    });
    await load();
    setBusy(false);
  }

  async function resume() {
    setBusy(true);
    await fetch("/api/settings", { method: "POST" });
    setMsg("재진입 재개됨");
    await load();
    setBusy(false);
  }

  async function saveSetting(patch: Record<string, unknown>) {
    setBusy(true);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await load();
    setBusy(false);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  if (loading) {
    return (
      <main className="sa-shell py-20 text-[var(--muted)]">불러오는 중…</main>
    );
  }

  if (!account) {
    return (
      <main className="sa-shell py-20">
        <p>연결된 계좌가 없습니다.</p>
        <Link href="/connect" className="sa-btn sa-btn-primary mt-4 inline-flex">
          계좌 연결하기
        </Link>
      </main>
    );
  }

  const spark = account.snapshots.map((s) => s.equity);
  if (spark.length === 0) spark.push(account.equity);

  return (
    <main className="sa-shell py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/" className="font-display text-2xl">
            Super Alpha
          </Link>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="sa-badge sa-badge-live">
              {account.mode === "live" ? "MT5 LIVE" : "DEMO PAPER"}
            </span>
            <span className="sa-badge">
              {account.login} · {account.server}
            </span>
            <span className="sa-badge">
              {account.mode === "live"
                ? account.syncAgeSec != null
                  ? `동기화 ${account.syncAgeSec}s 전`
                  : "EA 대기중"
                : account.botEnabled
                  ? "페이퍼 ON"
                  : "페이퍼 OFF"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {account.mode !== "live" && (
            <button className="sa-btn sa-btn-primary" disabled={busy} onClick={toggleBot}>
              {account.botEnabled ? "페이퍼 정지" : "페이퍼 시작"}
            </button>
          )}
          <button className="sa-btn sa-btn-ghost" disabled={busy} onClick={resume}>
            재진입 재개
          </button>
          <button className="sa-btn sa-btn-ghost" onClick={logout}>
            로그아웃
          </button>
        </div>
      </header>

      {account.syncToken && (
        <section className="sa-panel mt-4 border-[var(--accent)]/30">
          <div className="text-sm font-semibold text-[var(--accent)]">
            MT5 실데이터 연동 (필수)
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            웹 대시보드는 기본적으로 시뮬레이션입니다. 실제 MT5와 맞추려면 EA에 아래
            값을 넣고, MT5에서 WebRequest URL을 허용하세요.
          </p>
          <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
            <div>
              <div className="sa-label">InpWebUrl</div>
              <code className="break-all text-[var(--accent2)]">
                https://super-alpha-inky.vercel.app
              </code>
            </div>
            <div>
              <div className="sa-label">InpWebLogin</div>
              <code className="text-[var(--accent2)]">{account.login}</code>
            </div>
            <div className="md:col-span-2">
              <div className="sa-label">InpWebToken (Sync Token)</div>
              <code className="break-all text-[var(--accent2)]">{account.syncToken}</code>
            </div>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            MT5: 도구 → 옵션 → 전문가 어드바이저 → `https://super-alpha-inky.vercel.app` 허용
            체크. EA v1.20 이상 필요.
          </p>
        </section>
      )}

      {msg && <p className="mt-3 text-sm text-[var(--accent2)]">{msg}</p>}

      <section className="mt-8 grid gap-4 md:grid-cols-4">
        <div className="sa-panel md:col-span-2">
          <div className="text-sm text-[var(--muted)]">누적 수익률</div>
          <div
            className={`font-display mt-2 text-5xl ${
              account.totalReturnPct >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"
            }`}
          >
            {account.totalReturnPct >= 0 ? "+" : ""}
            {fmt(account.totalReturnPct)}%
          </div>
          <div className="mt-4">
            <Spark points={spark} />
          </div>
        </div>
        <div className="sa-panel">
          <div className="text-sm text-[var(--muted)]">데일리 수익률</div>
          <div className="mt-3 text-3xl text-[var(--accent2)]">
            {account.dailyReturnPct >= 0 ? "+" : ""}
            {fmt(account.dailyReturnPct)}%
          </div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            오늘 PnL ${fmt(account.dailyPnl)}
          </div>
        </div>
        <div className="sa-panel">
          <div className="text-sm text-[var(--muted)]">익절 / 손절</div>
          <div className="mt-3 text-3xl">
            {account.tpCount}
            <span className="text-[var(--muted)]"> / </span>
            {account.slCount}
          </div>
          <div className="mt-2 text-sm text-[var(--muted)]">사이클 {account.cycleCount}</div>
        </div>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="sa-panel">
          <div className="text-sm text-[var(--muted)]">잔고</div>
          <div className="mt-2 text-2xl">${fmt(account.balance)}</div>
        </div>
        <div className="sa-panel">
          <div className="text-sm text-[var(--muted)]">에쿼티</div>
          <div className="mt-2 text-2xl">${fmt(account.equity)}</div>
        </div>
        <div className="sa-panel">
          <div className="text-sm text-[var(--muted)]">시작 잔고</div>
          <div className="mt-2 text-2xl">${fmt(account.startingBalance)}</div>
        </div>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="sa-panel">
          <h2 className="text-lg font-semibold">열린 바스켓</h2>
          <div className="mt-4 space-y-3">
            {account.baskets.length === 0 && (
              <p className="text-sm text-[var(--muted)]">
                열린 포지션 없음. 자동매매를 켜면 DCA가 시작됩니다.
              </p>
            )}
            {account.baskets.map((b) => {
              const lots = b.legs.reduce((s, l) => s + l.lots, 0);
              return (
                <div
                  key={b.id}
                  className="flex items-center justify-between rounded-2xl border border-[var(--line)] px-4 py-3"
                >
                  <div>
                    <div className="font-medium">
                      {b.symbol} · {b.direction}
                    </div>
                    <div className="text-sm text-[var(--muted)]">
                      Level {b.filledLevel}/{account.config?.maxDcaLevel ?? 5} ·{" "}
                      {fmt(lots, 2)} lots · entry {fmt(b.firstEntryPrice, 5)}
                    </div>
                  </div>
                  <div
                    className={
                      b.unrealizedPnl >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"
                    }
                  >
                    {b.unrealizedPnl >= 0 ? "+" : ""}
                    {fmt(b.unrealizedPnl)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="sa-panel">
          <h2 className="text-lg font-semibold">최근 체결</h2>
          <div className="mt-4 max-h-72 space-y-2 overflow-auto">
            {account.fills.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between border-b border-[var(--line)] py-2 text-sm"
              >
                <div>
                  <span className="text-[var(--accent2)]">{f.kind}</span> {f.symbol}{" "}
                  {f.side} {fmt(f.lots, 2)} @ {fmt(f.price, f.symbol.includes("XAU") ? 2 : 5)}
                </div>
                <div className={f.pnl >= 0 ? "text-[var(--accent)]" : "text-[var(--danger)]"}>
                  {f.kind === "TP" || f.kind === "SL"
                    ? `${f.pnl >= 0 ? "+" : ""}${fmt(f.pnl)}`
                    : f.note}
                </div>
              </div>
            ))}
            {account.fills.length === 0 && (
              <p className="text-sm text-[var(--muted)]">아직 체결 기록이 없습니다.</p>
            )}
          </div>
        </div>
      </section>

      {account.config && (
        <section className="sa-panel mt-4">
          <h2 className="text-lg font-semibold">전략 설정</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="text-sm">
              <span className="sa-label">Base Lots</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                defaultValue={account.config.baseLots}
                onBlur={(e) =>
                  saveSetting({ baseLots: Number(e.target.value) })
                }
              />
            </label>
            <label className="text-sm">
              <span className="sa-label">익절 목표</span>
              <input
                className="sa-input"
                type="number"
                step="1"
                defaultValue={account.config.profitTarget}
                onBlur={(e) =>
                  saveSetting({ profitTarget: Number(e.target.value) })
                }
              />
            </label>
            <label className="text-sm">
              <span className="sa-label">Max DCA Level</span>
              <input
                className="sa-input"
                type="number"
                min={0}
                max={9}
                defaultValue={account.config.maxDcaLevel}
                onBlur={(e) =>
                  saveSetting({ maxDcaLevel: Number(e.target.value) })
                }
              />
            </label>
            <label className="text-sm">
              <span className="sa-label">DevScale</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                defaultValue={account.config.devScale}
                onBlur={(e) =>
                  saveSetting({ devScale: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={account.config.reenterAfterTp}
                onChange={(e) =>
                  saveSetting({ reenterAfterTp: e.target.checked })
                }
              />
              익절 후 재진입
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={account.config.reenterAfterSl}
                onChange={(e) =>
                  saveSetting({ reenterAfterSl: e.target.checked })
                }
              />
              손절 후 재진입
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={account.config.enableFinalSl}
                onChange={(e) =>
                  saveSetting({ enableFinalSl: e.target.checked })
                }
              />
              최종 DCA 손절
            </label>
          </div>
        </section>
      )}
    </main>
  );
}
