"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PUBLIC_LOGIC_OPTIONS, publicLogicLabel } from "@/lib/strategy-public";

/**
 * End-user strategy screen — presets are locked (no levels / ROI / drop tables).
 * Full editor remains admin-only via API.
 */
export default function StrategyLogicPage() {
  const [logicId, setLogicId] = useState("martin_9_65");
  const [summary, setSummary] = useState<{
    levelCount?: number;
    startLots?: number;
    takeProfitUsd?: number;
    stopLossUsd?: number;
  } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

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
    setSummary(data.summary || data.resolved || null);
    setBusy(false);
  }, []);

  useEffect(() => {
    void load(logicId);
  }, [logicId, load]);

  return (
    <div className="m-page">
      <header className="m-top">
        <Link href="/manage" className="m-back">
          ← 관리
        </Link>
        <h1>전략 프리셋</h1>
      </header>

      <section className="m-card" style={{ marginBottom: "0.85rem" }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.55 }}>
          전략의 <strong>세부 파라미터</strong>는 공개되지 않습니다.
          봇 화면에서 프리셋만 선택해 사용하세요.
        </p>
      </section>

      <section className="m-card">
        <label className="sa-label">프리셋</label>
        <select
          className="sa-input"
          value={logicId}
          disabled={busy}
          onChange={(e) => setLogicId(e.target.value)}
        >
          {PUBLIC_LOGIC_OPTIONS.filter((l) => l.id !== "custom").map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <div style={{ marginTop: "1rem" }}>
          <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.15rem" }}>
            {publicLogicLabel(logicId)}
          </h2>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>
            {PUBLIC_LOGIC_OPTIONS.find((l) => l.id === logicId)?.desc}
          </p>
        </div>

        {summary && (
          <ul
            style={{
              margin: "1.1rem 0 0",
              padding: "0.85rem 1rem",
              listStyle: "none",
              borderRadius: 12,
              border: "1px solid var(--line)",
              color: "var(--muted)",
              fontSize: "0.88rem",
              lineHeight: 1.6,
            }}
          >
            <li>최대 회차 수: 비공개 (엔진 내부)</li>
            <li>회차·익절·손절 조건: 비공개</li>
            <li>시작 로트는 봇 화면에서만 조정</li>
          </ul>
        )}

        {msg && (
          <p style={{ marginTop: "0.75rem", color: "var(--danger)", fontSize: "0.85rem" }}>
            {msg}
          </p>
        )}

        <Link
          href="/bot"
          className="sa-btn sa-btn-primary"
          style={{ display: "block", textAlign: "center", marginTop: "1.25rem" }}
        >
          봇에서 프리셋 선택하기
        </Link>
      </section>
    </div>
  );
}
