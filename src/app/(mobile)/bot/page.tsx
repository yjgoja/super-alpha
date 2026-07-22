"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PUBLIC_LOGIC_OPTIONS, publicLogicLabel } from "@/lib/strategy-public";
import { SYMBOL_GROUPS, normalizeLogicId } from "@/lib/strategies";
import { ConnectPrompt, isMt5Linked } from "@/components/ConnectPrompt";

type Bot = {
  id: string;
  symbol: string;
  enabled: boolean;
  logic: string;
  direction: string;
  startLots: number;
  repeatEnabled: boolean;
  stopOnSl: boolean;
  logicLabel?: string;
};

const LOT_SCALES = [2, 3, 5, 10] as const;

function roundLots(n: number) {
  return Math.max(0.01, Math.round(n * 100) / 100);
}

export default function BotPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botEnabled, setBotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Bot>>({});
  const [addSymbol, setAddSymbol] = useState("GBPUSD");
  const [ready, setReady] = useState(false);
  const [linked, setLinked] = useState(false);
  const [approved, setApproved] = useState(true);
  const [showConnect, setShowConnect] = useState(false);
  const [promptMode, setPromptMode] = useState<"connect" | "approval">("connect");

  const used = useMemo(() => new Set(bots.map((b) => b.symbol)), [bots]);
  const editingBot = useMemo(() => bots.find((b) => b.id === edit) || null, [bots, edit]);
  const availableGroups = useMemo(
    () =>
      SYMBOL_GROUPS.map((g) => ({
        ...g,
        symbols: g.symbols.filter((s) => !used.has(s)),
      })).filter((g) => g.symbols.length > 0),
    [used],
  );
  const availableSymbols = useMemo(
    () => availableGroups.flatMap((g) => [...g.symbols]),
    [availableGroups],
  );

  useEffect(() => {
    if (availableSymbols.length === 0) return;
    if (!(availableSymbols as string[]).includes(addSymbol)) {
      setAddSymbol(availableSymbols[0]!);
    }
  }, [availableSymbols, addSymbol]);

  const load = useCallback(async () => {
    const [botsRes, statsRes, meRes] = await Promise.all([
      fetch("/api/symbol-bots"),
      fetch("/api/stats"),
      fetch("/api/me"),
    ]);
    if (botsRes.status === 401 || statsRes.status === 401 || meRes.status === 401) {
      window.location.href = "/login";
      return;
    }
    const botsData = await botsRes.json();
    const statsData = await statsRes.json();
    const me = await meRes.json().catch(() => ({}));
    if (me.approvalStatus === "rejected") {
      window.location.href = "/pending";
      return;
    }
    setBots(botsData.bots || []);
    setBotEnabled(!!statsData.account?.botEnabled);
    setLinked(isMt5Linked(statsData.account));
    setApproved(me.role === "admin" || me.approvalStatus === "approved");
    setReady(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function requireLinked() {
    if (!approved) {
      setPromptMode("approval");
      setShowConnect(true);
      return false;
    }
    if (linked) return true;
    setPromptMode("connect");
    setShowConnect(true);
    return false;
  }

  async function toggleMaster() {
    if (!requireLinked()) return;
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
    if (enabled && !requireLinked()) return;
    setBusy(true);
    setMsg("");
    await fetch("/api/symbol-bots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: bot.symbol, direction: bot.direction, enabled }),
    });
    setBusy(false);
    const label = `${bot.symbol} ${bot.direction}`;
    setMsg(
      enabled
        ? botEnabled
          ? `${label} 켜짐 (전체 가동 중)`
          : `${label} 켜짐 — 전체 시작을 눌러야 실제 매매됩니다`
        : `${label} 꺼짐`,
    );
    await load();
  }

  async function saveEdit() {
    if (!editingBot) return;
    setBusy(true);
    setMsg("");
    const logic = normalizeLogicId((draft.logic as string) || "dubai_bruno_313");
    const lots = Number(draft.startLots ?? 0.01);
    if (!(lots > 0) || lots > 100) {
      setBusy(false);
      setMsg("시작 로트는 0.01~100 사이여야 합니다.");
      return;
    }
    // 세부 ROI·물타기·익절$는 서버 프리셋이 적용 — 클라이언트에서 보내지 않음
    const res = await fetch("/api/symbol-bots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: editingBot.symbol,
        logic,
        direction: editingBot.direction,
        startLots: roundLots(lots),
        repeatEnabled: draft.repeatEnabled,
        stopOnSl: draft.stopOnSl,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMsg(data.error || "저장 실패");
      return;
    }
    setEdit(null);
    setMsg("전략 설정을 저장했습니다. 다음 틱부터 엔진에 반영됩니다.");
    await load();
  }

  async function addBot(symbol = addSymbol) {
    if (!requireLinked()) return;
    if (!symbol || used.has(symbol)) {
      setMsg("이미 추가된 종목이거나 선택할 종목이 없습니다.");
      return;
    }
    setBusy(true);
    setMsg("");
    let ok = true;
    for (const direction of ["BUY", "SELL"] as const) {
      const res = await fetch("/api/symbol-bots", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          direction,
          enabled: false,
          logic: "dubai_bruno_313",
          startLots: 0.01,
          repeatEnabled: true,
          stopOnSl: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error || `${symbol} 추가 실패`);
        ok = false;
        break;
      }
    }
    setBusy(false);
    if (!ok) return;
    setMsg(`${symbol} BUY·SELL 봇 추가됨 (사용 중지 상태 · 켜서 사용)`);
    await load();
  }

  function openEdit(bot: Bot) {
    setEdit(bot.id);
    setDraft({
      logic: normalizeLogicId(bot.logic || "dubai_bruno_313"),
      direction: bot.direction,
      startLots: bot.startLots,
      repeatEnabled: bot.repeatEnabled,
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
            <div className="sm-brand-sub">봇</div>
          </div>
        </div>
      </header>

      <ConnectPrompt
        open={showConnect}
        onClose={() => setShowConnect(false)}
        mode={promptMode}
      />

      <section id="bot-add-symbol" className="m-card" style={{ marginBottom: "0.85rem" }}>
        <div style={{ fontWeight: 650, marginBottom: "0.35rem" }}>종목 추가</div>
        <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: "0.75rem" }}>
          아직 없는 종목을 고른 뒤 추가합니다.
        </div>
        {!ready ? (
          <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>불러오는 중…</p>
        ) : availableSymbols.length === 0 ? (
          <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>
            추가할 수 있는 종목이 없습니다. 이미 EUR / GBP / AUD / XAU가 모두 등록되어 있습니다.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {availableGroups.map((g) => (
              <div key={g.id}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--muted)",
                    marginBottom: "0.4rem",
                    letterSpacing: "0.02em",
                  }}
                >
                  {g.name}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  {g.symbols.map((s) => {
                    const on = addSymbol === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        className="sa-btn"
                        disabled={busy}
                        onClick={() => setAddSymbol(s)}
                        style={{
                          borderRadius: 12,
                          padding: "0.55rem 0.85rem",
                          border: on
                            ? "1px solid var(--gold)"
                            : "1px solid rgba(255,255,255,0.12)",
                          background: on ? "rgba(232,195,106,0.16)" : "rgba(255,255,255,0.04)",
                          color: on ? "var(--gold)" : "var(--ink)",
                          fontWeight: 650,
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button
              type="button"
              className="sa-btn sa-btn-primary"
              disabled={busy || !addSymbol || used.has(addSymbol)}
              onClick={() => addBot(addSymbol)}
              style={{ width: "100%", borderRadius: 12, padding: "0.75rem" }}
            >
              {addSymbol} 추가
            </button>
            {msg ? (
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--gold)" }}>{msg}</p>
            ) : null}
          </div>
        )}
      </section>

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

      {!ready ? (
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>불러오는 중…</p>
      ) : (
        <>
          <div style={{ marginBottom: "0.35rem", fontSize: "0.82rem", color: "var(--muted)" }}>
            종목별 설정
          </div>
          <p style={{ margin: "0 0 0.65rem", fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.45 }}>
            종목을 켜 두면 전체 시작 시 그 심볼만 매매합니다. 익절·손절·회차 조건은 선택한 프리셋이 엔진에서 처리합니다.
            {!botEnabled && bots.some((b) => b.enabled) ? (
              <span style={{ color: "var(--gold)" }}> (지금: 종목 켜짐 · 전체 정지)</span>
            ) : null}
          </p>

          <div style={{ display: "grid", gap: "0.7rem" }}>
            {bots.map((bot) => {
              const live = botEnabled && bot.enabled;
              return (
                <article key={bot.id} className="m-card">
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: "1.05rem" }}>{bot.symbol}</strong>
                        <span
                          className="m-chip"
                          style={{
                            color: bot.direction === "SELL" ? "var(--danger)" : "var(--ok, #0a7)",
                            fontWeight: 700,
                          }}
                        >
                          {bot.direction === "SELL" ? "SELL 매도" : "BUY 매수"}
                        </span>
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
                        {bot.logicLabel || publicLogicLabel(bot.logic)} · {bot.direction} · 시작{" "}
                        {bot.startLots} lot
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

                  {edit === bot.id ? (
                    <div style={{ marginTop: "1rem", display: "grid", gap: "0.75rem" }}>
                      <div>
                        <span className="sa-label">로직 프리셋</span>
                        <select
                          className="sa-select"
                          value={normalizeLogicId(
                            (draft.logic as string) || bot.logic || "dubai_bruno_313",
                          )}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              logic: e.target.value,
                            }))
                          }
                        >
                          {PUBLIC_LOGIC_OPTIONS.filter((l) => l.id !== "custom").map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                        <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--muted)" }}>
                          {PUBLIC_LOGIC_OPTIONS.find(
                            (l) =>
                              l.id ===
                              normalizeLogicId(
                                (draft.logic as string) || bot.logic || "",
                              ),
                          )?.desc || ""}
                        </p>
                      </div>

                      <div>
                        <span className="sa-label">방향 (봇 고정)</span>
                        <div className="sa-dir">
                          <button type="button" className={dir === "BUY" ? "is-on" : ""} disabled>
                            BUY (매수)
                          </button>
                          <button type="button" className={dir === "SELL" ? "is-on" : ""} disabled>
                            SELL (매도)
                          </button>
                        </div>
                        <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--muted)" }}>
                          BUY봇·SELL봇은 별도로 설정합니다.
                        </p>
                      </div>

                      <div>
                        <span className="sa-label">시작 로트</span>
                        <input
                          className="sa-input"
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={draft.startLots ?? bot.startLots}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              startLots: Number(e.target.value),
                            }))
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
                      프리셋 · 로트 설정
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
