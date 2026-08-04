"use client";

import { useCallback, useEffect, useState } from "react";
import { PUBLIC_LOGIC_OPTIONS, publicLogicLabel } from "@/lib/strategy-public";

type LevelRow = { lots: number; profit: number; drop: number };

type Payload = {
  mode: "bulk" | "levels";
  startLots?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  takeProfitUsd?: number;
  stopLossUsd?: number;
  levels?: LevelRow[];
};

type Props = {
  /** When set, auto-load this logic on mount */
  initialLogicId?: string;
  /** Admin remote target account (other MT5 accounts) */
  accountId?: string | null;
};

/**
 * Admin-only strategy table editor (mobile + desktop).
 * End users never receive full payload from GET /api/strategy-logic.
 */
export function AdminStrategyEditor({
  initialLogicId = "martin_9_65",
  accountId = null,
}: Props) {
  const [logicId, setLogicId] = useState(initialLogicId);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [editable, setEditable] = useState<"bulk" | "levels" | null>(null);
  const [hasOverride, setHasOverride] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const accountQs = accountId
    ? `&accountId=${encodeURIComponent(accountId)}`
    : "";

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setMsg("");
    setErr("");
    const res = await fetch(
      `/api/strategy-logic?logic=${encodeURIComponent(id)}${accountQs}`,
    );
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || "불러오기 실패");
      setPayload(null);
      return;
    }
    if (data.summary?.locked || data.resolved?.locked) {
      setLocked(true);
      setPayload(null);
      setEditable(null);
      return;
    }
    setLocked(false);
    setHasOverride(!!data.hasOverride);
    setEditable(data.editable === "levels" ? "levels" : "bulk");
    const p = (data.payload || {}) as Payload;
    setPayload({
      mode: p.mode === "levels" ? "levels" : "bulk",
      startLots: Number(p.startLots) || 0.01,
      takeProfitPct: Number(p.takeProfitPct) || 20,
      stopLossPct: Number(p.stopLossPct) || 0,
      takeProfitUsd: Number(p.takeProfitUsd) || 0,
      stopLossUsd: Number(p.stopLossUsd) || 0,
      levels: Array.isArray(p.levels)
        ? p.levels.map((lv) => ({
            lots: Number(lv.lots) || 0.01,
            profit: Number(lv.profit) || 20,
            drop: Number(lv.drop) || 0,
          }))
        : [],
    });
  }, [accountQs]);

  useEffect(() => {
    void load(logicId);
  }, [logicId, load]);

  async function save() {
    if (!payload) return;
    setBusy(true);
    setMsg("");
    setErr("");
    const body = {
      logicId,
      ...(accountId ? { accountId } : {}),
      payload: {
        mode: editable === "levels" ? "levels" : "bulk",
        startLots: payload.startLots,
        takeProfitPct: payload.takeProfitPct,
        stopLossPct: payload.stopLossPct,
        takeProfitUsd: payload.takeProfitUsd,
        stopLossUsd: payload.stopLossUsd,
        levels: editable === "levels" ? payload.levels : undefined,
      },
    };
    const res = await fetch("/api/strategy-logic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || "저장 실패");
      return;
    }
    setMsg("저장했습니다. 다음 틱부터 엔진에 반영됩니다.");
    await load(logicId);
  }

  async function reset() {
    if (!confirm("이 프리셋 오버라이드를 삭제하고 기본값으로 되돌릴까요?")) return;
    setBusy(true);
    setMsg("");
    setErr("");
    const res = await fetch("/api/strategy-logic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicId,
        reset: true,
        ...(accountId ? { accountId } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || "초기화 실패");
      return;
    }
    setMsg("기본값으로 되돌렸습니다.");
    await load(logicId);
  }

  function updateLevel(i: number, patch: Partial<LevelRow>) {
    setPayload((prev) => {
      if (!prev?.levels) return prev;
      const levels = prev.levels.map((lv, idx) => (idx === i ? { ...lv, ...patch } : lv));
      return { ...prev, levels, startLots: levels[0]?.lots ?? prev.startLots };
    });
  }

  function addLevel() {
    setPayload((prev) => {
      if (!prev) return prev;
      const levels = [...(prev.levels || [])];
      const last = levels[levels.length - 1];
      levels.push({
        lots: Math.max(0.01, Math.round((last?.lots || 0.01) * 200) / 100),
        profit: prev.takeProfitPct || last?.profit || 20,
        drop: (last?.drop || 0) + 10,
      });
      return { ...prev, levels };
    });
  }

  function removeLevel(i: number) {
    setPayload((prev) => {
      if (!prev?.levels || prev.levels.length <= 1) return prev;
      const levels = prev.levels.filter((_, idx) => idx !== i);
      if (levels[0]) levels[0] = { ...levels[0], drop: 0 };
      return { ...prev, levels, startLots: levels[0]?.lots ?? prev.startLots };
    });
  }

  if (locked) {
    return (
      <section className="m-card">
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.55 }}>
          전략 세부 파라미터는 관리자만 수정할 수 있습니다. 봇 화면에서 프리셋만 선택하세요.
        </p>
      </section>
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <section className="m-card">
        <label className="sa-label">프리셋</label>
        <select
          className="sa-input"
          value={logicId}
          disabled={busy}
          onChange={(e) => setLogicId(e.target.value)}
        >
          {PUBLIC_LOGIC_OPTIONS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <p style={{ margin: "0.55rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
          {publicLogicLabel(logicId)}
          {hasOverride ? " · 계좌 오버라이드 적용 중" : " · 기본 프리셋"}
          {editable ? ` · ${editable === "levels" ? "회차 편집" : "일괄 편집"}` : ""}
        </p>
      </section>

      {payload && (
        <section className="m-card" style={{ display: "grid", gap: "0.75rem" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.55rem",
            }}
          >
            <label>
              <span className="sa-label">시작 로트</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0.01"
                value={payload.startLots ?? 0.01}
                disabled={busy || editable === "levels"}
                onChange={(e) =>
                  setPayload((p) => (p ? { ...p, startLots: Number(e.target.value) } : p))
                }
              />
            </label>
            <label>
              <span className="sa-label">익절 ROI%</span>
              <input
                className="sa-input"
                type="number"
                step="0.1"
                min="1"
                value={payload.takeProfitPct ?? 20}
                disabled={busy}
                onChange={(e) => {
                  const takeProfitPct = Number(e.target.value);
                  setPayload((p) => {
                    if (!p) return p;
                    const levels = p.levels?.map((lv) => ({ ...lv, profit: takeProfitPct }));
                    return { ...p, takeProfitPct, levels };
                  });
                }}
              />
            </label>
            <label>
              <span className="sa-label">손절 ROI%</span>
              <input
                className="sa-input"
                type="number"
                step="0.1"
                min="0"
                value={payload.stopLossPct ?? 0}
                disabled={busy}
                onChange={(e) =>
                  setPayload((p) => (p ? { ...p, stopLossPct: Number(e.target.value) } : p))
                }
              />
            </label>
            <label>
              <span className="sa-label">익절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0.01"
                value={payload.takeProfitUsd ?? 0}
                disabled={busy}
                onChange={(e) =>
                  setPayload((p) => (p ? { ...p, takeProfitUsd: Number(e.target.value) } : p))
                }
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <span className="sa-label">손절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0"
                value={payload.stopLossUsd ?? 0}
                disabled={busy}
                onChange={(e) =>
                  setPayload((p) => (p ? { ...p, stopLossUsd: Number(e.target.value) } : p))
                }
              />
            </label>
          </div>

          {editable === "levels" && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.45rem",
                }}
              >
                <span className="sa-label" style={{ margin: 0 }}>
                  회차 (lots / drop%)
                </span>
                <button
                  type="button"
                  className="sa-btn sa-btn-ghost"
                  style={{ fontSize: "0.78rem", padding: "0.35rem 0.65rem" }}
                  disabled={busy}
                  onClick={addLevel}
                >
                  회차 추가
                </button>
              </div>
              <div style={{ display: "grid", gap: "0.45rem" }}>
                {(payload.levels || []).map((lv, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr 1fr auto",
                      gap: "0.35rem",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "0.75rem", color: "var(--muted)", width: "1.6rem" }}>
                      L{i}
                    </span>
                    <input
                      className="sa-input"
                      type="number"
                      step="0.01"
                      min="0.01"
                      aria-label={`L${i} lots`}
                      value={lv.lots}
                      disabled={busy}
                      onChange={(e) => updateLevel(i, { lots: Number(e.target.value) })}
                    />
                    <input
                      className="sa-input"
                      type="number"
                      step="0.1"
                      min="0"
                      aria-label={`L${i} drop`}
                      value={lv.drop}
                      disabled={busy || i === 0}
                      onChange={(e) => updateLevel(i, { drop: Number(e.target.value) })}
                    />
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{
                        fontSize: "0.72rem",
                        padding: "0.4rem",
                        color: "var(--danger)",
                        opacity: (payload.levels?.length || 0) <= 1 ? 0.35 : 1,
                      }}
                      disabled={busy || (payload.levels?.length || 0) <= 1}
                      onClick={() => removeLevel(i)}
                      aria-label={`L${i} 삭제`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            열린 바스켓이 있는 로직은 저장이 거부됩니다. 활성 계좌 기준으로 저장됩니다.
          </p>

          <div style={{ display: "flex", gap: "0.45rem" }}>
            <button
              type="button"
              className="sa-btn sa-btn-primary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "처리 중…" : "저장"}
            </button>
            <button
              type="button"
              className="sa-btn sa-btn-ghost"
              style={{ flex: 1 }}
              disabled={busy || !hasOverride}
              onClick={() => void reset()}
            >
              기본값
            </button>
          </div>
        </section>
      )}

      {err && (
        <p style={{ margin: 0, color: "var(--danger)", fontSize: "0.85rem" }}>{err}</p>
      )}
      {msg && (
        <p style={{ margin: 0, color: "var(--ok, #0a7)", fontSize: "0.85rem" }}>{msg}</p>
      )}
    </div>
  );
}
