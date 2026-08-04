"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AdminAccountPicker,
  readStoredAdminEditAccountId,
} from "@/components/AdminAccountPicker";
import { AdminStrategyEditor } from "@/components/AdminStrategyEditor";
import { publicLogicOptions, publicLogicLabel } from "@/lib/strategy-public";

/**
 * End-user: locked summary (IP).
 * Admin: full table editor on phone/desktop + any-account remote target.
 */
export default function StrategyLogicPage() {
  const [role, setRole] = useState<string | null>(null);
  const [logicId, setLogicId] = useState("martin_9_65");
  const [editAccountId, setEditAccountId] = useState<string | null>(null);

  useEffect(() => {
    setEditAccountId(readStoredAdminEditAccountId());
    (async () => {
      const res = await fetch("/api/me");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const me = await res.json().catch(() => ({}));
      setRole(me.role || "user");
    })();
  }, []);

  if (role === null) {
    return (
      <div className="m-page">
        <header className="m-top">
          <Link href="/manage" className="m-back">
            ← 관리
          </Link>
          <h1>전략 설정</h1>
        </header>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>불러오는 중…</p>
      </div>
    );
  }

  if (role === "admin") {
    return (
      <div className="m-page">
        <header className="m-top">
          <Link href="/manage" className="m-back">
            ← 관리
          </Link>
          <h1>전략 상세 편집</h1>
        </header>
        <p
          style={{
            margin: "0 0 0.85rem",
            color: "var(--muted)",
            fontSize: "0.85rem",
            lineHeight: 1.5,
          }}
        >
          폰에서도 PC처럼 아무 계좌의 회차·익절·손절을 수정합니다.
        </p>
        <AdminAccountPicker value={editAccountId} onChange={setEditAccountId} />
        <AdminStrategyEditor
          key={editAccountId || "active"}
          accountId={editAccountId}
        />
      </div>
    );
  }

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
          전략의 <strong>세부 파라미터</strong>는 공개되지 않습니다. 봇 화면에서 프리셋만
          선택해 사용하세요.
        </p>
      </section>

      <section className="m-card">
        <label className="sa-label">프리셋</label>
        <select
          className="sa-input"
          value={logicId}
          onChange={(e) => setLogicId(e.target.value)}
        >
          {publicLogicOptions().map((l) => (
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
            {publicLogicOptions().find((l) => l.id === logicId)?.desc}
          </p>
        </div>

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
