"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LOGIC_OPTIONS, SYMBOL_GROUPS, logicLabel } from "@/lib/strategies";
import {
  DCA1000_DEFAULT_DEFENSE,
  DCA1000_DEFAULT_SL_ROI,
  MT5_REF_MID,
  calcDca1000Defense,
  mt5TpMoneyTarget,
  roiToPricePct,
} from "@/lib/dca1000";
import { getTableLevels, isMartinLogic, martinMaxLevels, previewMartinLots, tableLogicMeta } from "@/lib/table-logics";
import type { Dca1000Level } from "@/lib/dca1000";

/** 표 기본 익절 ROI% (코인선물 profit 컬럼) */
const DEFAULT_TP_ROI = 20;

type Bot = {
  id: string;
  symbol: string;
  enabled: boolean;
  logic: string;
  direction: string;
  entryCount: number;
  entryMultiplier: number;
  entryIntervalPct: number;
  takeProfitPct: number;
  startLots: number;
  repeatEnabled: boolean;
  stopLossPct: number;
  stopLossEnabled: boolean;
  stopOnSl: boolean;
};

type Group = { id: string; name: string; symbols: readonly string[] };

const LOT_SCALES = [2, 3, 5, 10] as const;

function roundLots(n: number) {
  return Math.max(0.01, Math.round(n * 100) / 100);
}

function fmtNum(n: number, d = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function DefenseCard({
  defense,
}: {
  defense: ReturnType<typeof calcDca1000Defense>;
}) {
  return (
    <div className="m-calc-box">
      <div className="m-calc-title">계산결과</div>
      <div className="m-calc-row">
        <span>차트 방어폭 (평균)</span>
        <strong className="c-roi">{fmtNum(defense.roiDefensePct)} %</strong>
      </div>
      <div className="m-calc-row">
        <span>Buy 손절 (차트↓)</span>
        <strong className="c-long">{fmtNum(defense.spotLongPct)} %</strong>
      </div>
      <div className="m-calc-row">
        <span>Sell 손절 (차트↑)</span>
        <strong className="c-short">{fmtNum(defense.spotShortPct)} %</strong>
      </div>
      <div className="m-calc-row">
        <span>예상 손절금 (전체 회차)</span>
        <strong>{fmtNum(defense.estimatedSlAmount)}</strong>
      </div>
    </div>
  );
}

export default function BotPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [logicLevels, setLogicLevels] = useState<Record<string, Dca1000Level[]>>({});
  const [groups, setGroups] = useState<Group[]>([...SYMBOL_GROUPS]);
  const [botEnabled, setBotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Bot>>({});
  const [addSymbol, setAddSymbol] = useState("EURUSD");
  const [ready, setReady] = useState(false);

  const used = useMemo(() => new Set(bots.map((b) => b.symbol)), [bots]);

  function levelsFor(logic: string, mult: number): Dca1000Level[] {
    const saved = logicLevels[logic];
    if (saved && saved.length > 0) return saved;
    return getTableLevels(logic, mult);
  }

  const defense = useMemo(() => {
    if (!edit) return DCA1000_DEFAULT_DEFENSE;
    const logic = (draft.logic as string) || "dca_1000";
    const sl =
      draft.stopLossEnabled === false
        ? 0
        : Number(draft.stopLossPct ?? DCA1000_DEFAULT_SL_ROI);
    const mult = Number(draft.entryMultiplier ?? (isMartinLogic(logic) ? 2 : 1));
    return calcDca1000Defense({
      stopLossRoiPct: sl > 0 ? sl : DCA1000_DEFAULT_SL_ROI,
      startLots: Number(draft.startLots ?? 0.01),
      levels: levelsFor(logic, mult),
      symbol: edit,
    });
  }, [
    edit,
    draft.logic,
    draft.stopLossPct,
    draft.stopLossEnabled,
    draft.startLots,
    draft.entryMultiplier,
    logicLevels,
  ]);

  const martinPreview = useMemo(() => {
    const logic = (draft.logic as string) || "";
    if (!isMartinLogic(logic)) return [];
    const n = martinMaxLevels(logic);
    const start = Number(draft.startLots ?? 0.01);
    const mult = Number(draft.entryMultiplier ?? 2);
    return previewMartinLots(start, mult, n);
  }, [draft.logic, draft.startLots, draft.entryMultiplier]);

  const tpMoneyPreview = useMemo(() => {
    if (!edit) return null;
    const lots = Number(draft.startLots ?? 0.01);
    const tpRoi = Number(draft.takeProfitPct ?? DEFAULT_TP_ROI);
    const sym = edit.toUpperCase();
    const mid =
      MT5_REF_MID[
        sym.includes("XAU") || sym === "GOLD"
          ? "XAUUSD"
          : sym.includes("EUR")
            ? "EURUSD"
            : sym
      ] ?? (sym.includes("XAU") ? MT5_REF_MID.XAUUSD : MT5_REF_MID.EURUSD);
    return mt5TpMoneyTarget({
      symbol: edit,
      lots,
      avgPrice: mid,
      tpRoiPct: tpRoi,
      brokerLeverage: 500,
    });
  }, [edit, draft.startLots, draft.takeProfitPct]);

  const load = useCallback(async () => {
    const [botsRes, statsRes] = await Promise.all([
      fetch("/api/symbol-bots"),
      fetch("/api/stats"),
    ]);
    if (botsRes.status === 401 || statsRes.status === 401) {
      window.location.href = "/login";
      return;
    }
    const botsData = await botsRes.json();
    const statsData = await statsRes.json();
    if (!statsData.account?.metaApiAccountId) {
      window.location.href = "/connect";
      return;
    }
    setBots(botsData.bots || []);
    if (botsData.logicLevels) setLogicLevels(botsData.logicLevels);
    if (botsData.options?.groups) setGroups(botsData.options.groups);
    setBotEnabled(!!statsData.account.botEnabled);
    setReady(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleMaster() {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !botEnabled }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error || "실패");
      return;
    }
    setBotEnabled(!!data.botEnabled);
    setMsg(
      data.botEnabled
        ? "전체 시작: 켜 둔 종목만 매매합니다. 클라우드 API가 활성화되었습니다."
        : "전체 중지: 모든 종목 매매가 멈춥니다. 24시간 미사용 시 클라우드가 자동 중지되어 비용이 나가지 않습니다.",
    );
  }

  async function setSymbolEnabled(bot: Bot, enabled: boolean) {
    setBusy(true);
    setMsg("");
    await fetch("/api/symbol-bots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: bot.symbol, enabled }),
    });
    setBusy(false);
    setMsg(
      enabled
        ? botEnabled
          ? `${bot.symbol} 켜짐 (전체 가동 중)`
          : `${bot.symbol} 켜짐 — 전체 시작을 눌러야 실제 매매됩니다`
        : `${bot.symbol} 꺼짐`,
    );
    await load();
  }

  async function saveEdit() {
    if (!edit) return;
    setBusy(true);
    const logic = (draft.logic as string) || "dca_1000";
    const meta = tableLogicMeta(logic);
    const sl = Number(draft.stopLossPct ?? DCA1000_DEFAULT_SL_ROI);
    const mult = isMartinLogic(logic)
      ? Math.max(1.01, Number(draft.entryMultiplier ?? 2))
      : 1;
    const res = await fetch("/api/symbol-bots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: edit,
        logic,
        direction: draft.direction,
        startLots: draft.startLots,
        takeProfitPct: draft.takeProfitPct,
        stopLossPct: sl,
        stopLossEnabled: sl > 0 && draft.stopLossEnabled !== false,
        repeatEnabled: draft.repeatEnabled,
        stopOnSl: draft.stopOnSl,
        entryCount: meta.count,
        entryMultiplier: mult,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMsg(data.error || "저장 실패");
      return;
    }
    setEdit(null);
    setMsg("전략 설정을 저장했습니다.");
    await load();
  }

  async function addBot() {
    if (used.has(addSymbol)) {
      setMsg("이미 추가된 종목입니다.");
      return;
    }
    setBusy(true);
    const meta = tableLogicMeta("dca_1000");
    await fetch("/api/symbol-bots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: addSymbol,
        enabled: false,
        logic: "dca_1000",
        entryCount: meta.count,
        entryMultiplier: 1,
        startLots: 0.01,
        takeProfitPct: meta.firstTpRoi || DEFAULT_TP_ROI,
        stopLossPct: DCA1000_DEFAULT_SL_ROI,
        stopLossEnabled: true,
        repeatEnabled: true,
        stopOnSl: true,
      }),
    });
    setBusy(false);
    setMsg(`${addSymbol} 추가됨 (사용 중지 상태 · 켜서 사용)`);
    await load();
  }

  function openEdit(bot: Bot) {
    setEdit(bot.symbol);
    const logic = bot.logic || "dca_1000";
    const meta = tableLogicMeta(logic);
    const savedMult = Number(bot.entryMultiplier || 0);
    setDraft({
      logic,
      direction: bot.direction,
      takeProfitPct: bot.takeProfitPct > 5 ? bot.takeProfitPct : meta.firstTpRoi || DEFAULT_TP_ROI,
      startLots: bot.startLots,
      entryMultiplier: isMartinLogic(logic)
        ? savedMult > 1
          ? savedMult
          : 2
        : 1,
      repeatEnabled: bot.repeatEnabled,
      stopLossPct: bot.stopLossPct > 0 ? bot.stopLossPct : DCA1000_DEFAULT_SL_ROI,
      stopLossEnabled: bot.stopLossEnabled || bot.stopLossPct > 0,
      stopOnSl: bot.stopOnSl,
    });
  }

  function scaleLots(mult: number) {
    setDraft((d) => ({
      ...d,
      startLots: roundLots((d.startLots ?? 0.01) * mult),
    }));
  }

  const dir = ((draft.direction as string) || "BUY") as string;

  return (
    <>
      <header className="m-topbar">
        <h1>봇</h1>
      </header>

      <section className="m-card" style={{ marginBottom: "0.85rem" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>전체 시작 / 전체 중지</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
              계좌 자동매매 전원입니다. 꺼지면 아래 종목을 켜 둬도 주문하지 않습니다.
            </div>
            <div
              className={`m-status-text${botEnabled ? " is-on" : " is-off"}`}
              style={{ marginTop: "0.55rem" }}
            >
              {botEnabled ? "● 전체 가동 중" : "○ 전체 정지"}
            </div>
          </div>
          <button
            type="button"
            className={`m-switch${botEnabled ? " is-on" : ""}`}
            aria-label="전체 시작 중지"
            disabled={busy || !ready}
            onClick={toggleMaster}
          />
        </div>
        <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.75rem" }}>
          <button
            type="button"
            className="sa-btn sa-btn-primary"
            style={{ flex: 1, borderRadius: 12, padding: "0.7rem" }}
            disabled={busy || !ready || botEnabled}
            onClick={() => !botEnabled && toggleMaster()}
          >
            전체 시작
          </button>
          <button
            type="button"
            className="sa-btn sa-btn-ghost"
            style={{ flex: 1, borderRadius: 12, padding: "0.7rem", color: "var(--danger)" }}
            disabled={busy || !ready || !botEnabled}
            onClick={() => botEnabled && toggleMaster()}
          >
            전체 중지
          </button>
        </div>
        {msg && (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem", color: "var(--gold)" }}>{msg}</p>
        )}
      </section>

      {!edit && (
        <section className="m-card" style={{ marginBottom: "0.85rem" }}>
          <div style={{ fontWeight: 650, marginBottom: "0.55rem" }}>1000차 기본 방어폭</div>
          <DefenseCard defense={DCA1000_DEFAULT_DEFENSE} />
        </section>
      )}

      {!ready ? (
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>불러오는 중…</p>
      ) : (
        <>
          <div style={{ marginBottom: "0.35rem", fontSize: "0.82rem", color: "var(--muted)" }}>
            종목별 설정
          </div>
          <p style={{ margin: "0 0 0.65rem", fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.45 }}>
            종목을 켜 두면 전체 시작 시 그 심볼만 매매합니다.
            {!botEnabled && bots.some((b) => b.enabled) ? (
              <span style={{ color: "var(--gold)" }}> (지금: 종목 켜짐 · 전체 정지)</span>
            ) : null}
          </p>

          <div style={{ display: "grid", gap: "0.7rem" }}>
            {bots.map((bot) => {
              const cardDef = calcDca1000Defense({
                stopLossRoiPct:
                  bot.stopLossEnabled && bot.stopLossPct > 0
                    ? bot.stopLossPct
                    : DCA1000_DEFAULT_SL_ROI,
                startLots: bot.startLots,
                levels: levelsFor(
                  bot.logic || "dca_1000",
                  isMartinLogic(bot.logic || "")
                    ? bot.entryMultiplier > 1
                      ? bot.entryMultiplier
                      : 2
                    : 1,
                ),
                symbol: bot.symbol,
              });
              const live = botEnabled && bot.enabled;
              return (
                <article key={bot.id} className="m-card">
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: "1.05rem" }}>{bot.symbol}</strong>
                        <span className={`m-chip${bot.enabled ? " is-on" : ""}`}>
                          {bot.enabled ? "켜짐" : "꺼짐"}
                        </span>
                        {live ? (
                          <span className="m-chip is-on">매매중</span>
                        ) : bot.enabled && !botEnabled ? (
                          <span className="m-chip">대기</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.35rem" }}>
                        {logicLabel(bot.logic)} · {bot.direction} ·{" "}
                        {isMartinLogic(bot.logic)
                          ? `시작 ${bot.startLots} · ×${
                              bot.entryMultiplier > 1 ? bot.entryMultiplier : 2
                            }`
                          : `${bot.startLots} lot`}
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: "0.35rem" }}>
                        Buy↓ {fmtNum(cardDef.spotLongPct)}% · Sell↑ {fmtNum(cardDef.spotShortPct)}% ·
                        손절금 {fmtNum(cardDef.estimatedSlAmount)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`m-switch${bot.enabled ? " is-on" : ""}`}
                      disabled={busy}
                      onClick={() => setSymbolEnabled(bot, !bot.enabled)}
                      aria-label={`${bot.symbol} 종목 토글`}
                    />
                  </div>

                  <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.75rem" }}>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{
                        flex: 1,
                        borderRadius: 12,
                        padding: "0.65rem",
                        fontSize: "0.85rem",
                        opacity: bot.enabled ? 0.45 : 1,
                      }}
                      disabled={busy || bot.enabled}
                      onClick={() => setSymbolEnabled(bot, true)}
                    >
                      종목 켜기
                    </button>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{
                        flex: 1,
                        borderRadius: 12,
                        padding: "0.65rem",
                        fontSize: "0.85rem",
                        color: "var(--danger)",
                        opacity: !bot.enabled ? 0.45 : 1,
                      }}
                      disabled={busy || !bot.enabled}
                      onClick={() => setSymbolEnabled(bot, false)}
                    >
                      종목 끄기
                    </button>
                  </div>

                  {edit === bot.symbol ? (
                    <div style={{ marginTop: "1rem", display: "grid", gap: "0.75rem" }}>
                      <div>
                        <span className="sa-label">로직</span>
                        <select
                          className="sa-select"
                          value={(draft.logic as string) || bot.logic || "dca_1000"}
                          onChange={(e) => {
                            const logic = e.target.value;
                            const meta = tableLogicMeta(logic);
                            setDraft((d) => ({
                              ...d,
                              logic,
                              takeProfitPct: meta.firstTpRoi || DEFAULT_TP_ROI,
                              entryMultiplier: isMartinLogic(logic) ? 2 : 1,
                            }));
                          }}
                        >
                          {LOGIC_OPTIONS.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                        <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--muted)" }}>
                          {LOGIC_OPTIONS.find((l) => l.id === ((draft.logic as string) || bot.logic))
                            ?.desc || ""}
                        </p>
                      </div>

                      <div>
                        <span className="sa-label">방향</span>
                        <div className="sa-dir">
                          <button
                            type="button"
                            className={dir === "BUY" ? "is-on" : ""}
                            onClick={() => setDraft((d) => ({ ...d, direction: "BUY" }))}
                          >
                            BUY (매수)
                          </button>
                          <button
                            type="button"
                            className={dir === "SELL" ? "is-on" : ""}
                            onClick={() => setDraft((d) => ({ ...d, direction: "SELL" }))}
                          >
                            SELL (매도)
                          </button>
                        </div>
                      </div>

                      <div>
                        <span className="sa-label">
                          {isMartinLogic((draft.logic as string) || bot.logic)
                            ? "시작 계약수 (1회차 로트)"
                            : "회차당 계약수 (로트)"}
                        </span>
                        <input
                          className="sa-input"
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={draft.startLots ?? bot.startLots}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, startLots: Number(e.target.value) }))
                          }
                        />
                        <div className="m-scale-row">
                          {LOT_SCALES.map((m) => (
                            <button
                              key={m}
                              type="button"
                              className="m-scale-btn"
                              onClick={() => scaleLots(m)}
                            >
                              ×{m}
                            </button>
                          ))}
                        </div>
                      </div>

                      {isMartinLogic((draft.logic as string) || bot.logic) ? (
                        <div>
                          <span className="sa-label">단계별 배수 (마틴게일)</span>
                          <input
                            className="sa-input"
                            type="number"
                            step="0.1"
                            min="1.01"
                            max="10"
                            value={draft.entryMultiplier ?? 2}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                entryMultiplier: Number(e.target.value),
                              }))
                            }
                          />
                          <p
                            style={{
                              margin: "0.4rem 0 0",
                              fontSize: "0.72rem",
                              color: "var(--muted)",
                              lineHeight: 1.45,
                            }}
                          >
                            회차 로트 = 시작로트 × 배수^회차. 예: 0.01 · 배수 2 → 0.01 / 0.02 / 0.04 / …
                          </p>
                          <div
                            style={{
                              marginTop: "0.55rem",
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill, minmax(4.6rem, 1fr))",
                              gap: "0.35rem",
                              fontSize: "0.72rem",
                            }}
                          >
                            {martinPreview.map((row) => (
                              <div
                                key={row.level}
                                style={{
                                  padding: "0.35rem 0.4rem",
                                  borderRadius: 8,
                                  background: "var(--surface-2, rgba(0,0,0,0.04))",
                                  textAlign: "center",
                                }}
                              >
                                <div style={{ color: "var(--muted)" }}>L{row.level}</div>
                                <strong>{fmtNum(row.lots, 2)}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
                        <label>
                          <span className="sa-label">익절 ROI %</span>
                          <input
                            className="sa-input"
                            type="number"
                            step="1"
                            min="1"
                            value={draft.takeProfitPct ?? bot.takeProfitPct}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                takeProfitPct: Number(e.target.value),
                              }))
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
                            value={draft.stopLossPct ?? DCA1000_DEFAULT_SL_ROI}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                stopLossPct: Number(e.target.value),
                                stopLossEnabled: Number(e.target.value) > 0,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)", lineHeight: 1.45 }}>
                        익절·물타기 모두{" "}
                        <strong style={{ color: "var(--ink)" }}>손익÷MT5사용증거금×100 ≥ ROI%</strong>{" "}
                        (계좌 1:500). 목표$ ≈ (로트×계약×평단÷500)×ROI%. 손절만 전략표 ROI÷20
                        차트%.
                        {tpMoneyPreview != null ? (
                          <>
                            {" "}
                            → 1회차 약 <strong style={{ color: "var(--ink)" }}>${fmtNum(tpMoneyPreview)}</strong>
                          </>
                        ) : null}
                        . 익절 ROI {fmtNum(Number(draft.takeProfitPct ?? bot.takeProfitPct), 0)}% · 손절 ROI{" "}
                        {fmtNum(Number(draft.stopLossPct ?? DCA1000_DEFAULT_SL_ROI), 0)}% → 차트{" "}
                        {fmtNum(
                          roiToPricePct(Number(draft.stopLossPct ?? DCA1000_DEFAULT_SL_ROI)),
                          2,
                        )}
                        %.
                      </p>

                      <DefenseCard defense={defense} />

                      <div className="m-toggle-list">
                        <button
                          type="button"
                          className={`m-toggle-row${draft.repeatEnabled ? " is-on" : ""}`}
                          onClick={() =>
                            setDraft((d) => ({ ...d, repeatEnabled: !d.repeatEnabled }))
                          }
                        >
                          <span>
                            <strong>익절 후 재시작</strong>
                            <small>목표 수익 달성 후 다시 진입</small>
                          </span>
                          <em>{draft.repeatEnabled ? "켜짐" : "꺼짐"}</em>
                        </button>
                        <button
                          type="button"
                          className={`m-toggle-row${!draft.stopOnSl ? " is-on" : ""}`}
                          onClick={() => setDraft((d) => ({ ...d, stopOnSl: !d.stopOnSl }))}
                        >
                          <span>
                            <strong>손절 후 재시작</strong>
                            <small>손절 청산 후에도 매매 계속</small>
                          </span>
                          <em>{!draft.stopOnSl ? "켜짐" : "꺼짐"}</em>
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          type="button"
                          className="sa-btn sa-btn-primary"
                          style={{ flex: 1 }}
                          disabled={busy}
                          onClick={saveEdit}
                        >
                          저장
                        </button>
                        <button
                          type="button"
                          className="sa-btn sa-btn-ghost"
                          style={{ flex: 1 }}
                          onClick={() => setEdit(null)}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{ width: "100%", marginTop: "0.75rem", borderRadius: 12 }}
                      onClick={() => openEdit(bot)}
                    >
                      전략 · 로직 상세 설정
                    </button>
                  )}
                </article>
              );
            })}
          </div>

          <section className="m-card" style={{ marginTop: "0.85rem" }}>
            <div style={{ fontWeight: 650, marginBottom: "0.65rem" }}>종목 추가</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <select
                className="sa-select"
                value={addSymbol}
                onChange={(e) => setAddSymbol(e.target.value)}
                style={{ flex: 1 }}
              >
                {groups.map((g) => {
                  const avail = g.symbols.filter((s) => !used.has(s));
                  if (avail.length === 0) return null;
                  return (
                    <optgroup key={g.id} label={g.name}>
                      {avail.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <button type="button" className="sa-btn sa-btn-primary" disabled={busy} onClick={addBot}>
                추가
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
