"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LOGIC_OPTIONS } from "@/lib/strategies";
import {
  MT5_REF_MID,
  calcDca1000Defense,
  estimateTpMoneyForLevels,
  mt5TpMoneyTarget,
  roiToPricePct,
} from "@/lib/dca1000";

type LevelRow = { lots: number; profit: number; drop: number };

function isBulkLogic(logic: string) {
  return logic === "dca_1000" || logic === "dubai_bruno_313";
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
  const [logicId, setLogicId] = useState("martin_9");
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

  const tpMoneyL0 = useMemo(
    () =>
      mt5TpMoneyTarget({
        symbol,
        lots: editable === "levels" ? Number(payload?.levels?.[0]?.lots ?? startLots) : startLots,
        avgPrice: mid,
        tpRoiPct: tpRoi,
        brokerLeverage: 500,
      }),
    [symbol, mid, startLots, tpRoi, editable, payload?.levels],
  );

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
    const tpRaw = Number(payload.takeProfitPct ?? payload.levels?.[0]?.profit ?? 20);
    const slRaw = Number(payload.stopLossPct ?? 225);
    if (!(startLotsRaw > 0) || startLotsRaw > 100) {
      setBusy(false);
      setMsg("계약수(로트)는 0.01~100 사이여야 합니다.");
      return;
    }
    if (!(tpRaw >= 1) || tpRaw > 500) {
      setBusy(false);
      setMsg("익절 ROI%는 1~500 사이여야 합니다.");
      return;
    }
    if (!(slRaw >= 0) || slRaw > 1000) {
      setBusy(false);
      setMsg("손절 ROI%는 0~1000 사이여야 합니다.");
      return;
    }
    const body =
      editable === "bulk"
        ? {
            logicId,
            payload: {
              mode: "bulk" as const,
              leverageBase: 20,
              startLots: Math.max(0.01, Math.round(startLotsRaw * 100) / 100),
              takeProfitPct: tpRaw,
              stopLossPct: slRaw,
            },
          }
        : {
            logicId,
            payload: {
              mode: "levels" as const,
              leverageBase: 20,
              startLots: Math.max(0.01, Math.round(startLotsRaw * 100) / 100),
              takeProfitPct: tpRaw,
              stopLossPct: slRaw,
              // 바스켓 익절은 SymbolBot 단일 ROI — 회차별 profit도 동일 값으로 맞춤
              levels: (payload.levels || []).map((r, i) => ({
                lots: Number(r.lots),
                profit: tpRaw,
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
          <div style={{ fontWeight: 650 }}>일괄 설정 (전체 회차 동일)</div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            1000차·두바이는 회차 칸을 펼치지 않습니다. 계약수·익절·손절만 한 번에 적용하고, 물타기(drop)
            표는 기본 프리셋을 유지합니다.
          </p>
          <label>
            <span className="sa-label">전체 회차 계약수 (로트)</span>
            <input
              className="sa-input"
              type="number"
              step="0.01"
              min="0.01"
              value={payload.startLots ?? 0.01}
              onChange={(e) =>
                setPayload((p) => ({ ...p!, startLots: Number(e.target.value) }))
              }
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
            <label>
              <span className="sa-label">익절 ROI %</span>
              <input
                className="sa-input"
                type="number"
                step="1"
                min="1"
                max="500"
                value={payload.takeProfitPct ?? 20}
                onChange={(e) =>
                  setPayload((p) => ({ ...p!, takeProfitPct: Number(e.target.value) }))
                }
              />
            </label>
            <label>
              <span className="sa-label">손절 ROI %</span>
              <input
                className="sa-input"
                type="number"
                step="1"
                min="0"
                max="1000"
                value={payload.stopLossPct ?? 225}
                onChange={(e) =>
                  setPayload((p) => ({ ...p!, stopLossPct: Number(e.target.value) }))
                }
              />
            </label>
          </div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            익절·물타기: 손익÷MT5사용증거금×100 ≥ ROI% (계좌 1:500). 손절: 전략표 ROI÷20 차트% (
            {fmt(roiToPricePct(Number(payload.stopLossPct ?? 225)))}%). 다음 틱부터 엔진에 반영됩니다.
          </p>
          <div className="m-calc-box">
            <div className="m-calc-row">
              <span>1회차 예상 익절금</span>
              <strong>${fmt(tpMoneyL0)}</strong>
            </div>
            <div className="m-calc-row">
              <span>예상 손절금 (MT5·전체 회차)</span>
              <strong>${fmt(defense.estimatedSlAmount)}</strong>
            </div>
            <div className="m-calc-row">
              <span>차트 방어폭 (평균)</span>
              <strong>{fmt(defense.roiDefensePct)} %</strong>
            </div>
            <div className="m-calc-row" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
              <span>표 기준 손절금 (참고)</span>
              <strong>${fmt(defense.tableMarginSlAmount)}</strong>
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
              <span className="sa-label">바스켓 익절 ROI %</span>
              <input
                className="sa-input"
                type="number"
                min="1"
                max="500"
                value={payload.takeProfitPct ?? 20}
                onChange={(e) =>
                  setPayload((p) => ({ ...p!, takeProfitPct: Number(e.target.value) }))
                }
              />
            </label>
            <label>
              <span className="sa-label">손절 ROI %</span>
              <input
                className="sa-input"
                type="number"
                min="0"
                max="1000"
                value={payload.stopLossPct ?? 225}
                onChange={(e) =>
                  setPayload((p) => ({ ...p!, stopLossPct: Number(e.target.value) }))
                }
              />
            </label>
          </div>
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
            익절은 심볼 합산 증거금 ROI(1:500) 단일 기준입니다. 회차별 익절 ROI 칸은 미리보기용이며 저장 시
            위 값으로 통일됩니다. 손절은 ROI÷20 차트% ({fmt(roiToPricePct(Number(payload.stopLossPct ?? 225)))}
            %).
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                  <th style={{ padding: "0.35rem" }}>회차</th>
                  <th style={{ padding: "0.35rem" }}>계약수</th>
                  <th style={{ padding: "0.35rem" }}>물타기 ROI%</th>
                  <th style={{ padding: "0.35rem" }}>익절 ROI%</th>
                  <th style={{ padding: "0.35rem" }}>누적 익절$</th>
                  <th style={{ padding: "0.35rem" }} />
                </tr>
              </thead>
              <tbody>
                {(payload.levels || []).map((row, idx) => {
                  const levelsAsDca = (payload.levels || []).map((r, i) => ({
                    size: Math.round(
                      ((r.lots || 0.01) / (payload.levels![0]?.lots || 0.01)) * 10 * 100,
                    ) / 100,
                    profit: Number(payload.takeProfitPct ?? 20),
                    drop: i === 0 ? 0 : r.drop,
                  }));
                  const cum = estimateTpMoneyForLevels({
                    symbol,
                    levels: levelsAsDca,
                    filledThrough: idx,
                    startLots: Number(payload.levels?.[0]?.lots ?? startLots),
                    tpRoiPct: Number(payload.takeProfitPct ?? 20),
                    refMid: mid,
                  });
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
                        />
                      </td>
                      <td style={{ padding: "0.35rem", color: "var(--muted)" }}>
                        {fmt(Number(payload.takeProfitPct ?? 20), 0)}
                      </td>
                      <td style={{ padding: "0.35rem" }}>${fmt(cum.tpMoney)}</td>
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
              <span>L0 예상 익절금</span>
              <strong>${fmt(tpMoneyL0)}</strong>
            </div>
            <div className="m-calc-row">
              <span>예상 손절금 (MT5·전체 회차)</span>
              <strong>${fmt(defense.estimatedSlAmount)}</strong>
            </div>
            <div className="m-calc-row">
              <span>차트 방어폭 (평균)</span>
              <strong>{fmt(defense.roiDefensePct)} %</strong>
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
