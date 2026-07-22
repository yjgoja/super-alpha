"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LOGIC_OPTIONS } from "@/lib/strategies";
import {
  MT5_REF_MID,
  calcDca1000Defense,
  resolveTpSlUsd,
  roiPctToUsd,
  startLotsMarginUsd,
} from "@/lib/dca1000";

type LevelRow = { lots: number; profit: number; drop: number };

function isBulkLogic(logic: string) {
  return logic === "dubai_bruno_313";
}

function isLevelsEditableLogic(logic: string) {
  return logic === "custom" || /^martin_\d+$/i.test(logic);
}

type Payload = {
  mode: "bulk" | "levels";
  leverageBase?: number;
  startLots?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  takeProfitUsd?: number;
  stopLossUsd?: number;
  levels?: LevelRow[];
};

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function refMid(symbol: string) {
  const s = symbol.toUpperCase();
  if (s.includes("XAU") || s === "GOLD") return MT5_REF_MID.XAUUSD ?? 4080;
  return MT5_REF_MID.EURUSD ?? 1.085;
}

export default function StrategyLogicPage() {
  const [logicId, setLogicId] = useState("dubai_bruno_313");
  const [symbol, setSymbol] = useState("XAUUSD");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [hasOverride, setHasOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [addCount, setAddCount] = useState(3);
  const [bulkLots, setBulkLots] = useState(0.01);
  const [ready, setReady] = useState(false);

  const editable = isLevelsEditableLogic(logicId) ? "levels" : "bulk";

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setMsg("");
    const res = await fetch(`/api/strategy-logic?logic=${encodeURIComponent(id)}`);
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || "불러오기 실패");
      setBusy(false);
      return;
    }
    setPayload(data.payload);
    setHasOverride(!!data.hasOverride);
    setBulkLots(Number(data.payload?.startLots ?? 0.01));
    setReady(true);
    setBusy(false);
  }, []);

  useEffect(() => {
    load(logicId);
  }, [logicId, load]);

  const mid = refMid(symbol);
  const startLots = Number(payload?.startLots ?? 0.01);
  const tpRoi = Number(payload?.takeProfitPct ?? 20);
  const slRoi = Number(payload?.stopLossPct ?? 225);

  const usdTargets = useMemo(
    () =>
      resolveTpSlUsd({
        symbol,
        startLots:
          editable === "levels"
            ? Number(payload?.levels?.[0]?.lots ?? startLots)
            : startLots,
        takeProfitPct: tpRoi,
        stopLossPct: slRoi,
        refMid: mid,
      }),
    [symbol, mid, startLots, tpRoi, slRoi, editable, payload?.levels],
  );
  const tpMoneyL0 = usdTargets.takeProfitUsd;

  const defense = useMemo(() => {
    const levels =
      editable === "levels" && payload?.levels?.length
        ? payload.levels.map((r, i) => ({
            size: Math.round(((r.lots || 0.01) / (payload.levels![0]?.lots || 0.01)) * 10 * 100) / 100,
            profit: r.profit,
            drop: i === 0 ? 0 : r.drop,
          }))
        : undefined;
    return calcDca1000Defense({
      symbol,
      startLots,
      stopLossRoiPct: slRoi > 0 ? slRoi : 225,
      levels,
      refMid: mid,
    });
  }, [symbol, startLots, slRoi, editable, payload?.levels, mid]);

  async function save() {
    if (!payload) return;
    setBusy(true);
    setMsg("");
    const startLotsRaw =
      editable === "levels"
        ? Number(payload.levels?.[0]?.lots ?? payload.startLots ?? 0.01)
        : Number(payload.startLots ?? 0.01);
    const tpUsdRaw = Number(payload.takeProfitUsd ?? 0);
    const slUsdRaw = Number(payload.stopLossUsd ?? 0);
    if (!(startLotsRaw > 0) || startLotsRaw > 100) {
      setBusy(false);
      setMsg("계약수(로트)는 0.01~100 사이여야 합니다.");
      return;
    }
    if (!(tpUsdRaw >= 0.01) || tpUsdRaw > 1_000_000) {
      setBusy(false);
      setMsg("익절 $는 0.01~1000000 사이여야 합니다.");
      return;
    }
    if (!(slUsdRaw >= 0) || slUsdRaw > 1_000_000) {
      setBusy(false);
      setMsg("손절 $는 0~1000000 사이여야 합니다.");
      return;
    }
    const derived = resolveTpSlUsd({
      symbol,
      startLots: startLotsRaw,
      takeProfitPct: Number(payload.takeProfitPct ?? 20),
      stopLossPct: Number(payload.stopLossPct ?? 225),
      refMid: mid,
    });
    const body =
      editable === "bulk"
        ? {
            logicId,
            payload: {
              mode: "bulk" as const,
              leverageBase: 20,
              startLots: Math.max(0.01, Math.round(startLotsRaw * 100) / 100),
              takeProfitUsd: derived.takeProfitUsd,
              stopLossUsd: derived.stopLossUsd,
              takeProfitPct: derived.takeProfitPct,
              stopLossPct: derived.stopLossPct,
            },
          }
        : {
            logicId,
            payload: {
              mode: "levels" as const,
              leverageBase: 20,
              startLots: Math.max(0.01, Math.round(startLotsRaw * 100) / 100),
              takeProfitUsd: derived.takeProfitUsd,
              stopLossUsd: derived.stopLossUsd,
              takeProfitPct: derived.takeProfitPct,
              stopLossPct: derived.stopLossPct,
              levels: (payload.levels || []).map((r, i) => ({
                lots: Number(r.lots),
                profit: derived.takeProfitPct,
                drop: i === 0 ? 0 : Number(r.drop),
              })),
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
      setMsg(data.error || "저장 실패");
      return;
    }
    setHasOverride(true);
    setMsg("저장했습니다. 이 로직을 쓰는 종목에 반영됩니다.");
    await load(logicId);
  }

  async function resetPreset() {
    if (!window.confirm("이 로직을 기본 프리셋으로 되돌릴까요?")) return;
    setBusy(true);
    await fetch("/api/strategy-logic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logicId, reset: true }),
    });
    setBusy(false);
    setMsg("프리셋으로 되돌렸습니다.");
    await load(logicId);
  }

  function updateLevel(idx: number, patch: Partial<LevelRow>) {
    setPayload((p) => {
      if (!p?.levels) return p;
      const levels = p.levels.map((row, i) => (i === idx ? { ...row, ...patch } : row));
      if (idx === 0) levels[0] = { ...levels[0], drop: 0 };
      return { ...p, levels, startLots: levels[0]?.lots ?? p.startLots };
    });
  }

  function removeLevel(idx: number) {
    setPayload((p) => {
      if (!p?.levels || p.levels.length <= 1) return p;
      const levels = p.levels.filter((_, i) => i !== idx).map((r, i) => (i === 0 ? { ...r, drop: 0 } : r));
      return { ...p, levels, startLots: levels[0]?.lots };
    });
  }

  function addLevels(n: number) {
    const count = Math.max(1, Math.min(30, Math.floor(n)));
    setPayload((p) => {
      const cur = p?.levels || [];
      const last = cur[cur.length - 1] || { lots: 0.01, profit: 20, drop: 10 };
      const nextDrop = last.drop > 0 ? last.drop + 10 : 10;
      const added: LevelRow[] = Array.from({ length: count }, (_, i) => ({
        lots: last.lots,
        profit: last.profit,
        drop: cur.length === 0 && i === 0 ? 0 : nextDrop + i * 10,
      }));
      const levels = [...cur, ...added].map((r, i) => (i === 0 ? { ...r, drop: 0 } : r));
      return { ...(p || { mode: "levels" }), mode: "levels", levels, startLots: levels[0].lots };
    });
  }

  function applyAllLots() {
    const lots = Math.max(0.01, Math.round(bulkLots * 100) / 100);
    setPayload((p) => {
      if (!p?.levels) return { ...(p || { mode: "levels" }), mode: "levels", startLots: lots, levels: [] };
      return {
        ...p,
        startLots: lots,
        levels: p.levels.map((r) => ({ ...r, lots })),
      };
    });
  }

  return (
    <>
      <header className="m-topbar" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Link href="/manage" style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
          ← 관리
        </Link>
        <h1 style={{ flex: 1 }}>전략로직 상세설정</h1>
      </header>

      <section className="m-card" style={{ marginBottom: "0.75rem", display: "grid", gap: "0.65rem" }}>
        <label>
          <span className="sa-label">로직</span>
          <select
            className="sa-select"
            value={logicId}
            disabled={busy}
            onChange={(e) => setLogicId(e.target.value)}
          >
            {LOGIC_OPTIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.72rem", color: "var(--muted)" }}>
            {LOGIC_OPTIONS.find((l) => l.id === logicId)?.desc}
            {hasOverride ? " · 수정본 적용 중" : " · 기본 프리셋"}
          </p>
        </label>

        <label>
          <span className="sa-label">예상 $ 기준 심볼</span>
          <select className="sa-select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="EURUSD">EURUSD</option>
            <option value="XAUUSD">XAUUSD (금)</option>
          </select>
        </label>
      </section>

      {!ready || !payload ? (
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>불러오는 중…</p>
      ) : editable === "bulk" || isBulkLogic(logicId) ? (
        <section className="m-card" style={{ display: "grid", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <div style={{ fontWeight: 650 }}>일괄 설정 (로트·손절)</div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            알파지속로직 회차 익절 ROI는 정본 표 티어(20→25→30→45→60→70→100→110→125%)를
            그대로 씁니다. 아래에서 바꾸는 익절%는 시작회차(L0) 미리보기용이며, 물타기 drop·회차 TP
            표는 덮어쓰지 않습니다.
          </p>
          <label>
            <span className="sa-label">전체 회차 계약수 (로트)</span>
            <input
              className="sa-input"
              type="number"
              step="0.01"
              min="0.01"
              value={payload.startLots ?? 0.01}
              onChange={(e) => {
                const lots = Number(e.target.value);
                const usd = resolveTpSlUsd({
                  symbol,
                  startLots: lots,
                  takeProfitPct: Number(payload.takeProfitPct ?? 20),
                  stopLossPct: Number(payload.stopLossPct ?? 225),
                  refMid: mid,
                });
                setPayload((p) => ({
                  ...p!,
                  startLots: lots,
                  takeProfitUsd: usd.takeProfitUsd,
                  stopLossUsd: usd.stopLossUsd,
                }));
              }}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
            <label>
              <span className="sa-label">시작회차 익절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0.01"
                value={usdTargets.takeProfitUsd}
                onChange={(e) => {
                  const tpUsd = Number(e.target.value);
                  const margin = usdTargets.marginUsd;
                  const pct =
                    margin > 0 && tpUsd > 0
                      ? Math.round((tpUsd / margin) * 100 * 100) / 100
                      : Number(payload.takeProfitPct ?? 20);
                  setPayload((p) => ({
                    ...p!,
                    takeProfitUsd: tpUsd,
                    takeProfitPct: pct,
                  }));
                }}
              />
            </label>
            <label>
              <span className="sa-label">시작회차 손절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0"
                value={usdTargets.stopLossUsd}
                onChange={(e) => {
                  const slUsd = Number(e.target.value);
                  const margin = usdTargets.marginUsd;
                  const pct =
                    margin > 0 && slUsd > 0
                      ? Math.round((slUsd / margin) * 100 * 100) / 100
                      : Number(payload.stopLossPct ?? 225);
                  setPayload((p) => ({
                    ...p!,
                    stopLossUsd: slUsd,
                    stopLossPct: pct,
                  }));
                }}
              />
            </label>
          </div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            엔진: 바스켓 마진 ROI(바이낸스식) — 익절·손절 모두 증거금×ROI%. 시작회차 미리보기 (심볼{" "}
            {symbol}, 증거금 ${fmt(usdTargets.marginUsd)}). 전체 회차 시 손절은 아래 참고금.
          </p>
          <div className="m-calc-box">
            <div className="m-calc-row">
              <span>현재(시작회차) 익절$</span>
              <strong style={{ color: "var(--ok, #0a7)" }}>+${fmt(tpMoneyL0)}</strong>
            </div>
            <div className="m-calc-row">
              <span>현재(시작회차) 손절$</span>
              <strong style={{ color: "var(--danger)" }}>-${fmt(usdTargets.stopLossUsd)}</strong>
            </div>
            <div className="m-calc-row" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
              <span>전체 회차 채웠을 때 예상 손절금</span>
              <strong>${fmt(defense.estimatedSlAmount)}</strong>
            </div>
          </div>
        </section>
      ) : (
        <section className="m-card" style={{ display: "grid", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <div style={{ fontWeight: 650 }}>회차별 설정</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.45rem", alignItems: "end" }}>
            <label>
              <span className="sa-label">회차 N개 한번에 추가</span>
              <input
                className="sa-input"
                type="number"
                min="1"
                max="30"
                value={addCount}
                onChange={(e) => setAddCount(Number(e.target.value))}
              />
            </label>
            <button type="button" className="sa-btn sa-btn-ghost" onClick={() => addLevels(addCount)}>
              추가
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.45rem", alignItems: "end" }}>
            <label>
              <span className="sa-label">전체 회차 계약수 일괄</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0.01"
                value={bulkLots}
                onChange={(e) => setBulkLots(Number(e.target.value))}
              />
            </label>
            <button type="button" className="sa-btn sa-btn-ghost" onClick={applyAllLots}>
              적용
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
            <label>
              <span className="sa-label">시작회차 익절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0.01"
                value={usdTargets.takeProfitUsd}
                onChange={(e) => {
                  const tpUsd = Number(e.target.value);
                  const margin = usdTargets.marginUsd;
                  const pct =
                    margin > 0 && tpUsd > 0
                      ? Math.round((tpUsd / margin) * 100 * 100) / 100
                      : Number(payload.takeProfitPct ?? 20);
                  setPayload((p) => ({
                    ...p!,
                    takeProfitUsd: tpUsd,
                    takeProfitPct: pct,
                  }));
                }}
              />
            </label>
            <label>
              <span className="sa-label">시작회차 손절 $</span>
              <input
                className="sa-input"
                type="number"
                step="0.01"
                min="0"
                value={usdTargets.stopLossUsd}
                onChange={(e) => {
                  const slUsd = Number(e.target.value);
                  const margin = usdTargets.marginUsd;
                  const pct =
                    margin > 0 && slUsd > 0
                      ? Math.round((slUsd / margin) * 100 * 100) / 100
                      : Number(payload.stopLossPct ?? 225);
                  setPayload((p) => ({
                    ...p!,
                    stopLossUsd: slUsd,
                    stopLossPct: pct,
                  }));
                }}
              />
            </label>
          </div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            익절$/손절$ = 바스켓 증거금×ROI%(회차↑면 증가). 물타기 필요$ = 회차 로트 증거금 ×
            dropROI%.
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                  <th style={{ padding: "0.35rem" }}>회차</th>
                  <th style={{ padding: "0.35rem" }}>계약수</th>
                  <th style={{ padding: "0.35rem" }}>물타기$</th>
                  <th style={{ padding: "0.35rem" }}>익절$</th>
                  <th style={{ padding: "0.35rem" }} />
                </tr>
              </thead>
              <tbody>
                {(payload.levels || []).map((row, idx) => {
                  const dropUsd =
                    idx === 0
                      ? 0
                      : roiPctToUsd(
                          startLotsMarginUsd({
                            symbol,
                            startLots: Number(row.lots || 0.01),
                            refMid: mid,
                          }),
                          Number(row.drop || 0),
                        );
                  return (
                    <tr key={idx} style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                      <td style={{ padding: "0.35rem" }}>L{idx}</td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          className="sa-input"
                          style={{ minWidth: "4.2rem", padding: "0.35rem" }}
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={row.lots}
                          onChange={(e) => updateLevel(idx, { lots: Number(e.target.value) })}
                        />
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <input
                          className="sa-input"
                          style={{ minWidth: "4.2rem", padding: "0.35rem" }}
                          type="number"
                          step="1"
                          min="0"
                          disabled={idx === 0}
                          value={idx === 0 ? 0 : row.drop}
                          onChange={(e) => updateLevel(idx, { drop: Number(e.target.value) })}
                          title={idx === 0 ? "" : `≈ $${fmt(dropUsd)} (표 drop ROI%)`}
                        />
                        {idx > 0 ? (
                          <div style={{ fontSize: "0.65rem", color: "var(--muted)" }}>
                            ≈ ${fmt(dropUsd)}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: "0.35rem", color: "var(--muted)" }}>
                        ${fmt(tpMoneyL0)}
                      </td>
                      <td style={{ padding: "0.35rem" }}>
                        <button
                          type="button"
                          className="sa-btn sa-btn-ghost"
                          style={{ padding: "0.25rem 0.45rem", fontSize: "0.72rem" }}
                          disabled={(payload.levels?.length || 0) <= 1}
                          onClick={() => removeLevel(idx)}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="m-calc-box">
            <div className="m-calc-row">
              <span>회차 수</span>
              <strong>{payload.levels?.length || 0}</strong>
            </div>
            <div className="m-calc-row">
              <span>시작회차 익절$</span>
              <strong style={{ color: "var(--ok, #0a7)" }}>+${fmt(tpMoneyL0)}</strong>
            </div>
            <div className="m-calc-row">
              <span>시작회차 손절$</span>
              <strong style={{ color: "var(--danger)" }}>-${fmt(usdTargets.stopLossUsd)}</strong>
            </div>
            <div className="m-calc-row" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
              <span>전체 회차 채웠을 때 예상 손절금</span>
              <strong>${fmt(defense.estimatedSlAmount)}</strong>
            </div>
          </div>
        </section>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <button
          type="button"
          className="sa-btn sa-btn-primary"
          style={{ flex: 1 }}
          disabled={busy || !payload}
          onClick={save}
        >
          저장
        </button>
        <button
          type="button"
          className="sa-btn sa-btn-ghost"
          style={{ flex: 1 }}
          disabled={busy || !hasOverride}
          onClick={resetPreset}
        >
          프리셋 복원
        </button>
      </div>

      {msg && (
        <p style={{ margin: "0 0 1rem", fontSize: "0.85rem", color: "var(--gold)" }}>{msg}</p>
      )}
    </>
  );
}
