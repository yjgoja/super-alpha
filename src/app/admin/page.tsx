"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Overview = {
  summary: {
    users: number;
    accounts: number;
    pending: number;
    connected: number;
    undeployed: number;
    failed: number;
    botsOn: number;
    openBaskets: number;
    fillsToday: number;
    waste: number;
    billingActive: number;
  };
  cost: {
    estimatedMonthlyUsd: number;
    wasteMonthlyUsd: number;
    afterOptimizeMonthlyUsd: number;
    potentialSaveUsd: number;
    fmt: { estimated: string; waste: string; afterOptimize: string; save: string };
  };
  wasteAccounts: Array<{
    id: string;
    login: string;
    email: string;
    userId: string;
    equity: number;
    monthlyBurnUsd: number;
  }>;
  bots: Array<{
    id: string;
    login: string;
    email: string;
    userId: string;
    equity: number;
    balance: number;
    tpCount: number;
    slCount: number;
    lastSyncAt: string | null;
  }>;
  pendingAccounts: Array<{
    id: string;
    login: string;
    email: string;
    userId: string;
    status: string;
  }>;
};

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  approvalStatus: string;
  createdAt: string;
  accounts: Array<{
    id: string;
    login: string;
    server: string;
    status: string;
    statusMessage: string | null;
    mode: string;
    botEnabled: boolean;
    lastSyncAt: string | null;
    metaApiAccountId: string | null;
    balance: number;
    equity: number;
    tpCount: number;
    slCount: number;
    cycleCount: number;
  }>;
};

type Detail = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    approvalStatus: string;
    createdAt: string;
  };
  accounts: Array<{
    id: string;
    login: string;
    server: string;
    status: string;
    statusMessage: string | null;
    botEnabled: boolean;
    balance: number;
    equity: number;
    tpCount: number;
    slCount: number;
    cycleCount: number;
    lastSyncAt: string | null;
    metaApiAccountId: string | null;
    cost: { burning: boolean; monthlyUsd: number };
    config: Record<string, unknown> | null;
    baskets: Array<{
      symbol: string;
      direction: string;
      filledLevel: number;
      unrealizedPnl: number;
      legs: Array<{ level: number; lots: number; price: number }>;
    }>;
    fills: Array<{
      id: string;
      kind: string;
      symbol: string;
      lots: number;
      pnl: number;
      createdAt: string;
    }>;
  }>;
};

type Tab = "dashboard" | "approve" | "members";

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const res = await fetch("/api/admin/overview");
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "대시보드 로드 실패");
      return;
    }
    setOverview(data);
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "회원 로드 실패");
      return [] as UserRow[];
    }
    const next = (data.users || []) as UserRow[];
    setUsers(next);
    return next;
  }, []);

  const boot = useCallback(async () => {
    const me = await fetch("/api/me").then((r) => r.json());
    if (me.error || me.role !== "admin") {
      window.location.href = "/login";
      return;
    }
    await Promise.all([loadOverview(), loadUsers()]);
  }, [loadOverview, loadUsers]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void boot();
    }, 0);
    // Users list is cheap now (no MetaAPI finalize). Overview less often.
    const usersId = setInterval(() => {
      void loadUsers();
    }, 20_000);
    const overviewId = setInterval(() => {
      void loadOverview();
    }, 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(usersId);
      clearInterval(overviewId);
    };
  }, [boot, loadOverview, loadUsers]);

  async function patch(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    setMsg("");
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "처리 실패");
      return;
    }
    setMsg(data.message || "완료");
    await Promise.all([loadOverview(), loadUsers()]);
    if (detail) await openDetail(detail.user.id);

    // Keep polling while broker connection is in progress
    if (body.action === "provision" && data.pending) {
      let n = 0;
      const poll = setInterval(async () => {
        n += 1;
        await fetch("/api/admin/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check_provision" }),
        }).catch(() => null);
        const list = await loadUsers();
        const still = list.some((u) =>
          u.accounts.some(
            (a) => a.status === "provisioning" || a.status === "pending_registration",
          ),
        );
        if (!still || n >= 40) {
          clearInterval(poll);
          setMsg(still ? "아직 연결 중입니다. 잠시 후 새로고침해주세요." : "계좌 연동이 완료되었습니다.");
          await Promise.all([loadUsers(), loadOverview()]);
        }
      }, 5000);
    }
  }

  async function openDetail(userId: string) {
    setBusy(`d-${userId}`);
    const res = await fetch(`/api/admin/users/${userId}`);
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "상세 로드 실패");
      return;
    }
    setDetail(data);
  }

  async function optimize() {
    if (!confirm("미사용(봇 OFF) 클라우드를 모두 중지할까요? 과금이 크게 줄어듭니다.")) return;
    setBusy("optimize");
    setError("");
    const res = await fetch("/api/admin/overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "optimize" }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "최적화 실패");
      return;
    }
    setMsg(data.message || "최적화 완료");
    await Promise.all([loadOverview(), loadUsers()]);
  }

  async function deleteUser(userId: string, email: string) {
    if (!confirm(`${email} 회원을 삭제할까요?\nMetaAPI 클라우드도 함께 삭제되어 과금이 중단됩니다.`)) {
      return;
    }
    await patch({ action: "delete_user", userId }, `del-${userId}`);
    setDetail(null);
  }

  const pendingServers = users.filter((u) =>
    u.accounts.some((a) => a.status === "pending_registration" || a.status === "provisioning"),
  );
  const pendingMembers = users.filter(
    (u) => u.role !== "admin" && u.approvalStatus === "pending",
  );
  const approveCount = pendingServers.length + pendingMembers.length;

  return (
    <main className="sa-shell py-8">
      <header className="sa-nav">
        <div>
          <Link href="/" className="font-display text-2xl">
            Super Alpha
          </Link>
          <div className="mt-1 text-sm text-[var(--muted)]">관리자 콘솔</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["dashboard", "대시보드"],
              ["approve", "연동 승인"],
              ["members", "회원"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`sa-btn text-sm py-2 px-4 ${tab === k ? "sa-btn-primary" : "sa-btn-ghost"}`}
              onClick={() => setTab(k)}
            >
              {label}
              {k === "approve" && approveCount > 0 ? ` (${approveCount})` : ""}
            </button>
          ))}
          <button
            className="sa-btn sa-btn-ghost text-sm py-2 px-4"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/";
            }}
          >
            로그아웃
          </button>
        </div>
      </header>

      {error && <p className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
      {msg && <p className="mt-4 text-sm text-[var(--ok)]">{msg}</p>}

      {tab === "dashboard" && overview && (
        <>
          <section className="sa-grid-3 mt-6">
            <div className="sa-panel">
              <div className="sa-metric">
                <span>회원</span>
                <strong>{overview.summary.users}</strong>
              </div>
            </div>
            <div className="sa-panel">
              <div className="sa-metric">
                <span>봇 ON</span>
                <strong className="text-[var(--ok)]">{overview.summary.botsOn}</strong>
              </div>
            </div>
            <div className="sa-panel">
              <div className="sa-metric">
                <span>승인 대기</span>
                <strong className="text-[var(--warn)]">{overview.summary.pending}</strong>
              </div>
            </div>
            <div className="sa-panel">
              <div className="sa-metric">
                <span>클라우드 과금 중</span>
                <strong>{overview.summary.billingActive}</strong>
              </div>
            </div>
            <div className="sa-panel">
              <div className="sa-metric">
                <span>낭비 중 (봇OFF)</span>
                <strong className="text-[var(--danger)]">{overview.summary.waste}</strong>
              </div>
            </div>
            <div className="sa-panel">
              <div className="sa-metric">
                <span>오늘 체결</span>
                <strong>{overview.summary.fillsToday}</strong>
              </div>
            </div>
          </section>

          <section className="sa-panel mt-4 border-[var(--warn)]/40">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">비용 최적화 (필수)</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  추정 월 MetaAPI ≈ {overview.cost.fmt.estimated} · 낭비{" "}
                  <span className="text-[var(--danger)]">{overview.cost.fmt.waste}</span> · 최적화 후{" "}
                  {overview.cost.fmt.afterOptimize} (절감 {overview.cost.fmt.save})
                </p>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  규칙: 승인 시 CONNECTED 확인 후 클라우드 유지 · 봇 ON 중 undeploy/삭제 금지 · 봇 OFF 24시간 미사용 시만 undeploy · 삭제 시 MetaAPI 완전 제거
                </p>
              </div>
              <button
                className="sa-btn sa-btn-primary"
                disabled={busy === "optimize" || overview.summary.waste === 0}
                onClick={optimize}
              >
                {busy === "optimize" ? "최적화 중…" : "미사용 클라우드 일괄 중지"}
              </button>
            </div>

            {overview.wasteAccounts.length > 0 && (
              <div className="mt-4 space-y-2">
                {overview.wasteAccounts.map((w) => (
                  <div
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-sm"
                  >
                    <div>
                      <button className="text-[var(--gold)]" onClick={() => openDetail(w.userId)}>
                        {w.email}
                      </button>
                      <span className="text-[var(--muted)]"> · {w.login}</span>
                      <span className="ml-2 text-[var(--danger)]">
                        ~${w.monthlyBurnUsd.toFixed(2)}/월 낭비
                      </span>
                    </div>
                    <button
                      className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                      disabled={busy === `u-${w.id}`}
                      onClick={() => patch({ accountId: w.id, action: "undeploy" }, `u-${w.id}`)}
                    >
                      즉시 중지
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="sa-grid-2 mt-4">
            <div className="sa-panel">
              <h2 className="text-sm text-[var(--muted)]">실행 중 봇</h2>
              {overview.bots.length === 0 && (
                <p className="mt-3 text-sm text-[var(--muted)]">없음</p>
              )}
              <div className="mt-3 space-y-2">
                {overview.bots.map((b) => (
                  <div key={b.id} className="flex justify-between gap-2 text-sm">
                    <button className="text-left text-[var(--gold)]" onClick={() => openDetail(b.userId)}>
                      {b.email}
                      <div className="text-xs text-[var(--muted)]">
                        {b.login} · ${b.equity.toFixed(2)} · TP{b.tpCount}/SL{b.slCount}
                      </div>
                    </button>
                    <button
                      className="sa-btn sa-btn-danger text-xs py-2 px-3"
                      disabled={busy === `sb-${b.id}`}
                      onClick={() => patch({ accountId: b.id, action: "stop_bot" }, `sb-${b.id}`)}
                    >
                      정지+중지
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="sa-panel">
              <h2 className="text-sm text-[var(--muted)]">상태 요약</h2>
              <ul className="mt-3 space-y-2 text-sm text-[var(--muted)]">
                <li>연동 완료(클라우드 OFF): {overview.summary.undeployed}</li>
                <li>클라우드 ON: {overview.summary.connected}</li>
                <li>실패: {overview.summary.failed}</li>
                <li>오픈 바스켓: {overview.summary.openBaskets}</li>
              </ul>
            </div>
          </section>
        </>
      )}

      {tab === "approve" && (
        <section className="sa-panel mt-6 space-y-8">
          <div>
            <h2 className="text-lg font-semibold">회원 승인 대기</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              가입 회원입니다. 승인한 뒤 실계좌 연동 신청을 받을 수 있습니다.
            </p>
            <div className="mt-4 space-y-3">
              {pendingMembers.length === 0 && (
                <p className="text-sm text-[var(--muted)]">대기 없음</p>
              )}
              {pendingMembers.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] p-4"
                >
                  <div>
                    <button className="font-medium text-[var(--gold)]" onClick={() => openDetail(u.id)}>
                      {u.email}
                    </button>
                    <div className="mt-1 text-sm text-[var(--muted)]">
                      {u.name || "-"} · {new Date(u.createdAt).toLocaleString("ko-KR")}
                    </div>
                    <div className="mt-1 text-xs text-[var(--warn)]">approval · pending</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="sa-btn sa-btn-primary text-xs py-2 px-3"
                      disabled={busy === `ap-${u.id}`}
                      onClick={() =>
                        patch({ userId: u.id, approvalStatus: "approved" }, `ap-${u.id}`)
                      }
                    >
                      회원 승인
                    </button>
                    <button
                      className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                      disabled={busy === `rj-${u.id}`}
                      onClick={() =>
                        patch({ userId: u.id, approvalStatus: "rejected" }, `rj-${u.id}`)
                      }
                    >
                      거절
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold">계좌 연동 승인 대기</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              회원이 제출한 MT5 계좌입니다. 승인 시 비밀번호를 MetaAPI로 검증합니다. 틀리면
              실패 처리되어 회원이 다시 신청해야 합니다.
            </p>
            <div className="mt-4 space-y-3">
              {pendingServers.length === 0 && (
                <p className="text-sm text-[var(--muted)]">대기 없음</p>
              )}
              {pendingServers.map((u) => {
                const a = u.accounts[0];
                return (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] p-4"
                  >
                    <div>
                      <button className="font-medium text-[var(--gold)]" onClick={() => openDetail(u.id)}>
                        {u.email}
                      </button>
                      <div className="mt-1 text-sm text-[var(--muted)]">
                        Account <strong className="text-[var(--ink)]">{a.login}</strong> ·{" "}
                        {a.server}
                      </div>
                      <div className="mt-1 text-xs text-[var(--warn)]">
                        {a.status}
                        {a.statusMessage ? ` · ${a.statusMessage}` : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="sa-btn sa-btn-primary text-xs py-2 px-3"
                        disabled={busy === a.id || u.approvalStatus !== "approved"}
                        title={
                          u.approvalStatus !== "approved"
                            ? "먼저 회원 승인이 필요합니다"
                            : undefined
                        }
                        onClick={() => patch({ accountId: a.id, action: "provision" }, a.id)}
                      >
                        {busy === a.id
                          ? "연동 중…"
                          : a.status === "provisioning"
                            ? "상태 확인/재시도"
                            : "연동 승인"}
                      </button>
                      <button
                        className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                        disabled={busy === `r-${a.id}`}
                        onClick={() =>
                          patch({ accountId: a.id, action: "reject_account" }, `r-${a.id}`)
                        }
                      >
                        거절
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {tab === "members" && (
        <section className="sa-panel mt-6 overflow-x-auto">
          <h2 className="text-lg font-semibold">전체 회원</h2>
          <table className="sa-table mt-4 min-w-[960px]">
            <thead>
              <tr>
                <th>이메일</th>
                <th>회원상태</th>
                <th>MT5</th>
                <th>연동</th>
                <th>Equity</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const a = u.accounts[0];
                return (
                  <tr key={u.id}>
                    <td>
                      <button className="text-[var(--gold)]" onClick={() => openDetail(u.id)}>
                        {u.email}
                      </button>
                      <div className="text-xs text-[var(--muted)]">
                        {u.role} · {new Date(u.createdAt).toLocaleDateString("ko-KR")}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`text-xs ${
                          u.approvalStatus === "approved"
                            ? "text-[var(--ok)]"
                            : u.approvalStatus === "rejected"
                              ? "text-[var(--danger)]"
                              : "text-[var(--warn)]"
                        }`}
                      >
                        {u.approvalStatus}
                      </span>
                      {u.approvalStatus === "pending" && u.role !== "admin" && (
                        <div className="mt-1 flex gap-1">
                          <button
                            className="sa-btn sa-btn-primary text-xs py-1 px-2"
                            disabled={busy === `ap-${u.id}`}
                            onClick={() =>
                              patch({ userId: u.id, approvalStatus: "approved" }, `ap-${u.id}`)
                            }
                          >
                            승인
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="text-[var(--muted)]">{a ? a.login : "-"}</td>
                    <td>
                      {a ? (
                        <span className="text-xs">
                          {a.status}
                          {a.botEnabled ? " · BOT" : ""}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{a ? `$${a.equity.toFixed(2)}` : "-"}</td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                          onClick={() => openDetail(u.id)}
                        >
                          상세
                        </button>
                        {a?.metaApiAccountId && a.status === "connected" && (
                          <button
                            className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                            disabled={busy === `u-${a.id}`}
                            onClick={() =>
                              patch({ accountId: a.id, action: "undeploy" }, `u-${a.id}`)
                            }
                          >
                            클라우드 중지
                          </button>
                        )}
                        {u.role !== "admin" && (
                          <button
                            className="sa-btn sa-btn-danger text-xs py-2 px-3"
                            disabled={busy === `del-${u.id}`}
                            onClick={() => deleteUser(u.id, u.email)}
                          >
                            삭제
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="sa-panel max-h-[90vh] w-full max-w-2xl overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{detail.user.email}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {detail.user.role} · {detail.user.approvalStatus} ·{" "}
                  {new Date(detail.user.createdAt).toLocaleString("ko-KR")}
                </p>
              </div>
              <button className="sa-btn sa-btn-ghost text-sm py-2 px-3" onClick={() => setDetail(null)}>
                닫기
              </button>
            </div>

            {detail.accounts.length === 0 && (
              <p className="mt-4 text-sm text-[var(--muted)]">연결된 계좌 없음</p>
            )}

            {detail.accounts.map((a) => (
              <div key={a.id} className="mt-4 rounded-2xl border border-[var(--line)] p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    <div className="font-semibold">
                      {a.login} · {a.server}
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {a.status} {a.botEnabled ? "· BOT ON" : "· BOT OFF"} · 월 추정 $
                      {a.cost.monthlyUsd.toFixed(2)}
                      {a.cost.burning ? " (과금 중)" : ""}
                    </div>
                    {a.statusMessage && (
                      <div className="mt-1 text-xs text-[var(--warn)]">{a.statusMessage}</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold">${a.equity.toFixed(2)}</div>
                    <div className="text-xs text-[var(--muted)]">bal ${a.balance.toFixed(2)}</div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-[var(--muted)]">
                  <div>
                    TP <strong className="block text-[var(--ink)]">{a.tpCount}</strong>
                  </div>
                  <div>
                    SL <strong className="block text-[var(--ink)]">{a.slCount}</strong>
                  </div>
                  <div>
                    Cycle <strong className="block text-[var(--ink)]">{a.cycleCount}</strong>
                  </div>
                </div>

                {a.config && (
                  <div className="mt-3 text-xs text-[var(--muted)]">
                    DCA: {String(a.config.symbol)} {String(a.config.direction)} · 진입{" "}
                    {String(a.config.entryCount)} · 배율 {String(a.config.entryMultiplier)} · 간격{" "}
                    {String(a.config.entryIntervalPct)}% · TP {String(a.config.takeProfitPct)}%
                  </div>
                )}

                {a.baskets[0] && (
                  <div className="mt-3 text-sm">
                    바스켓 {a.baskets[0].symbol} L{a.baskets[0].filledLevel} · 미실현 $
                    {a.baskets[0].unrealizedPnl.toFixed(2)}
                  </div>
                )}

                <div className="mt-3 max-h-40 overflow-y-auto text-xs">
                  {a.fills.map((f) => (
                    <div key={f.id} className="flex justify-between border-t border-[var(--line)] py-1">
                      <span>
                        {f.kind} {f.symbol} {f.lots}
                      </span>
                      <span>${f.pnl.toFixed(2)}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {a.status === "connected" && (
                    <button
                      className="sa-btn sa-btn-ghost text-xs py-2 px-3"
                      disabled={busy === `u-${a.id}`}
                      onClick={() => patch({ accountId: a.id, action: "undeploy" }, `u-${a.id}`)}
                    >
                      클라우드 중지
                    </button>
                  )}
                  {a.botEnabled && (
                    <button
                      className="sa-btn sa-btn-danger text-xs py-2 px-3"
                      disabled={busy === `sb-${a.id}`}
                      onClick={() => patch({ accountId: a.id, action: "stop_bot" }, `sb-${a.id}`)}
                    >
                      봇 정지+중지
                    </button>
                  )}
                  {a.metaApiAccountId && (
                    <button
                      className="sa-btn sa-btn-danger text-xs py-2 px-3"
                      disabled={busy === `pg-${a.id}`}
                      onClick={() => {
                        if (confirm("MetaAPI 계좌를 완전 삭제할까요? 재승인 필요합니다.")) {
                          patch({ accountId: a.id, action: "purge_meta" }, `pg-${a.id}`);
                        }
                      }}
                    >
                      Meta 완전삭제
                    </button>
                  )}
                </div>
              </div>
            ))}

            {detail.user.role !== "admin" && (
              <button
                className="sa-btn sa-btn-danger mt-4 w-full"
                disabled={busy === `del-${detail.user.id}`}
                onClick={() => deleteUser(detail.user.id, detail.user.email)}
              >
                회원 삭제 (MetaAPI 포함)
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
