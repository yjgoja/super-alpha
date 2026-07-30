"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type AccountRow = {
  id: string;
  displayName: string | null;
  label: string;
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
  openBaskets: number;
  linked: boolean;
  active: boolean;
};

export default function ManagePage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [rename, setRename] = useState("");
  const [maxAccounts, setMaxAccounts] = useState(10);

  const load = useCallback(async () => {
    const res = await fetch("/api/accounts", { cache: "no-store" });
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (res.status === 403) {
      window.location.href = "/pending";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "계좌 목록을 불러오지 못했습니다.");
      setLoaded(true);
      return;
    }
    const list = (data.accounts || []) as AccountRow[];
    setAccounts(list);
    setMaxAccounts(Number(data.maxAccounts) || 10);
    const aid = (data.activeAccountId as string | null) || list.find((a) => a.active)?.id || null;
    setActiveId(aid);
    setSelectedId((prev) => {
      if (prev && list.some((a) => a.id === prev)) return prev;
      return aid || list[0]?.id || null;
    });
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = accounts.find((a) => a.id === selectedId) || null;

  useEffect(() => {
    setRename(selected?.displayName || "");
  }, [selected?.id, selected?.displayName]);

  async function selectAccount(id: string) {
    setSelectedId(id);
    setBusy(`sel-${id}`);
    setError("");
    setMsg("");
    const res = await fetch("/api/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select", accountId: id }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "계좌 선택 실패");
      return;
    }
    setActiveId(id);
    setMsg("활성 계좌로 선택했습니다.");
    await load();
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy("rename");
    setError("");
    setMsg("");
    const res = await fetch("/api/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "rename",
        accountId: selected.id,
        displayName: rename.trim() || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "이름 저장 실패");
      return;
    }
    setMsg("계좌 이름을 저장했습니다.");
    await load();
  }

  async function removeAccount() {
    if (!selected) return;
    if (
      !confirm(
        `${selected.label} 계좌를 삭제할까요?\nMetaAPI 클라우드도 함께 정리됩니다.\n(봇 ON / 열린 바스켓이 있으면 삭제되지 않습니다)`,
      )
    ) {
      return;
    }
    setBusy("del");
    setError("");
    setMsg("");
    const res = await fetch("/api/accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: selected.id }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(data.error || "삭제 실패");
      return;
    }
    setMsg("계좌를 삭제했습니다.");
    setSelectedId(null);
    await load();
  }

  const statusKo = (a: AccountRow) => {
    if (a.statusMessage) return a.statusMessage;
    switch (a.status) {
      case "connected":
        return "연동 완료";
      case "pending_registration":
        return "관리자 승인 대기";
      case "provisioning":
        return "연동 진행 중";
      case "failed":
        return "연동 실패";
      case "undeployed":
        return "클라우드 중지";
      default:
        return a.status;
    }
  };

  return (
    <>
      <header className="m-topbar">
        <h1>계좌 관리</h1>
      </header>

      {error && (
        <div className="m-card" style={{ marginBottom: "0.55rem", color: "var(--danger)" }}>
          {error}
        </div>
      )}
      {msg && (
        <div className="m-card" style={{ marginBottom: "0.55rem", color: "var(--ok)" }}>
          {msg}
        </div>
      )}

      <section className="m-card" style={{ marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}>
          <div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>등록 계좌</div>
            <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>
              {loaded ? `${accounts.length} / ${maxAccounts}` : "—"}
            </div>
          </div>
          <Link
            href="/connect?add=1"
            className="sa-btn sa-btn-primary"
            style={{ alignSelf: "center", textDecoration: "none", fontSize: "0.85rem" }}
          >
            계좌 추가
          </Link>
        </div>
        <p style={{ margin: "0.65rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
          계좌를 선택하면 홈·봇·시장 화면에 해당 계좌 정보가 표시됩니다.
        </p>
      </section>

      {!loaded && <div className="m-card">불러오는 중…</div>}

      {loaded && accounts.length === 0 && (
        <section className="m-card" style={{ marginBottom: "0.75rem" }}>
          <div style={{ fontWeight: 700 }}>등록된 계좌가 없습니다</div>
          <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            계좌 추가로 MT5 실계좌를 등록하세요.
          </div>
          <Link
            href="/connect?add=1"
            className="sa-btn sa-btn-primary"
            style={{
              display: "inline-block",
              marginTop: "0.85rem",
              textDecoration: "none",
              fontSize: "0.85rem",
            }}
          >
            첫 계좌 등록
          </Link>
        </section>
      )}

      <div style={{ display: "grid", gap: "0.55rem", marginBottom: "0.85rem" }}>
        {accounts.map((a) => {
          const isSel = a.id === selectedId;
          const isActive = a.id === activeId;
          return (
            <button
              key={a.id}
              type="button"
              className="m-card"
              disabled={busy === `sel-${a.id}`}
              onClick={() => void selectAccount(a.id)}
              style={{
                textAlign: "left",
                cursor: "pointer",
                width: "100%",
                border: isSel ? "1px solid var(--gold)" : undefined,
                boxShadow: isSel ? "0 0 0 1px rgba(212,175,55,0.25)" : undefined,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                <div style={{ fontWeight: 700 }}>
                  {a.label}
                  {isActive ? (
                    <span style={{ marginLeft: "0.45rem", color: "var(--gold)", fontSize: "0.75rem" }}>
                      사용 중
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: "0.85rem", fontWeight: 650 }}>
                  ${a.equity.toFixed(2)}
                </div>
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.3rem" }}>
                MT5 {a.login} · {a.server}
                {a.botEnabled ? " · BOT ON" : " · BOT OFF"}
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--gold)", marginTop: "0.35rem" }}>
                {statusKo(a)}
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <section className="m-card" style={{ marginBottom: "0.75rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>선택 계좌 정보</div>
          <div style={{ fontWeight: 700, fontSize: "1.1rem", marginTop: "0.35rem" }}>
            {selected.label}
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.35rem" }}>
            MT5 {selected.login} · {selected.server}
          </div>
          <div style={{ fontSize: "0.8rem", marginTop: "0.55rem", color: "var(--gold)" }}>
            {statusKo(selected)}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "0.65rem",
              marginTop: "0.85rem",
              textAlign: "center",
            }}
          >
            <div>
              <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>Equity</div>
              <div style={{ fontWeight: 700 }}>${selected.equity.toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>Balance</div>
              <div style={{ fontWeight: 700 }}>${selected.balance.toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>열린 바스켓</div>
              <div style={{ fontWeight: 700 }}>{selected.openBaskets}</div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "0.65rem",
              marginTop: "0.65rem",
              textAlign: "center",
              fontSize: "0.85rem",
            }}
          >
            <div>
              TP <strong>{selected.tpCount}</strong>
            </div>
            <div>
              SL <strong>{selected.slCount}</strong>
            </div>
            <div>
              Cycle <strong>{selected.cycleCount}</strong>
            </div>
          </div>

          <form onSubmit={saveName} style={{ marginTop: "1rem" }}>
            <label style={{ fontSize: "0.78rem", color: "var(--muted)", display: "block" }}>
              계좌 이름
            </label>
            <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.35rem" }}>
              <input
                className="sa-input"
                value={rename}
                maxLength={40}
                placeholder={`예: 메인 / ${selected.login}`}
                onChange={(e) => setRename(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="submit"
                className="sa-btn sa-btn-primary"
                disabled={busy === "rename"}
                style={{ fontSize: "0.85rem" }}
              >
                저장
              </button>
            </div>
          </form>

          <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.85rem" }}>
            <Link
              href={`/connect?reapply=1&accountId=${encodeURIComponent(selected.id)}`}
              className="m-card"
              style={{ display: "block" }}
            >
              <div style={{ fontWeight: 650 }}>비밀번호 재연동 신청</div>
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                비번 오류·서버 재신청
              </div>
            </Link>
            <Link href="/manage/strategy" className="m-card" style={{ display: "block" }}>
              <div style={{ fontWeight: 650 }}>전략로직 상세설정</div>
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                선택 계좌 기준
              </div>
            </Link>
            <button
              type="button"
              className="m-card"
              style={{
                textAlign: "left",
                cursor: "pointer",
                width: "100%",
                color: "var(--danger)",
              }}
              disabled={busy === "del"}
              onClick={() => void removeAccount()}
            >
              <div style={{ fontWeight: 650 }}>계좌 삭제</div>
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                MetaAPI 포함 · 봇 OFF / 무포지션일 때만
              </div>
            </button>
          </div>
        </section>
      )}

      <Link href="/mypage" className="m-card" style={{ display: "block", marginBottom: "1rem" }}>
        <div style={{ fontWeight: 650 }}>← 마이페이지</div>
      </Link>
    </>
  );
}
