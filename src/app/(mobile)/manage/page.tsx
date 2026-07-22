"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ConnectPrompt, isMt5Linked } from "@/components/ConnectPrompt";

export default function ManagePage() {
  const [login, setLogin] = useState("");
  const [server, setServer] = useState("");
  const [status, setStatus] = useState("");
  const [locked, setLocked] = useState(false);
  const [linked, setLinked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/stats");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 403) {
        window.location.href = "/pending";
        return;
      }
      const data = await res.json();
      if (data.role === "admin" && !data.account) {
        window.location.href = "/admin";
        return;
      }
      if (data.account) {
        setLogin(data.account.login);
        setServer(data.account.server);
        setStatus(data.account.statusMessage || data.account.status);
        setLinked(isMt5Linked(data.account));
        setLocked(
          !!data.account.metaApiAccountId &&
            ["connected", "undeployed", "provisioning", "pending_registration"].includes(
              data.account.status,
            ),
        );
      } else {
        setStatus("실계좌 연동 전");
        setLinked(false);
        setLocked(false);
      }
      setLoaded(true);
    })();
  }, []);

  return (
    <>
      <header className="m-topbar">
        <h1>관리</h1>
      </header>

      <ConnectPrompt open={showConnect} onClose={() => setShowConnect(false)} />

      <section className="m-card" style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>연동 계좌</div>
        <div style={{ fontWeight: 700, fontSize: "1.15rem", marginTop: "0.35rem" }}>
          {loaded ? login || "미연결" : "—"}
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.25rem" }}>
          {server || (linked ? "" : "MT5 실계좌를 연결하세요")}
        </div>
        <div style={{ fontSize: "0.8rem", marginTop: "0.65rem", color: "var(--gold)" }}>
          {status}
        </div>
        {locked && (
          <p style={{ margin: "0.65rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
            승인된 계좌·서버는 수정할 수 없습니다. 변경이 필요하면 관리자에게 문의하세요.
          </p>
        )}
      </section>

      <div style={{ display: "grid", gap: "0.55rem" }}>
        {locked ? (
          <div className="m-card" style={{ opacity: 0.85 }}>
            <div style={{ fontWeight: 650 }}>계좌 연동</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
              연동 완료 · 수정 불가
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="m-card"
            style={{ display: "block", textAlign: "left", cursor: "pointer", width: "100%" }}
            onClick={() => setShowConnect(true)}
          >
            <div style={{ fontWeight: 650 }}>계좌 연동</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
              MT5 로그인 · 서버 등록
            </div>
          </button>
        )}
        <Link
          href="/connect?reapply=1"
          className="m-card"
          style={{ display: "block" }}
        >
          <div style={{ fontWeight: 650 }}>실계좌 다시 연결 신청</div>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
            비밀번호 오류·재신청 시 사용
          </div>
        </Link>
        <Link href="/manage/strategy" className="m-card" style={{ display: "block" }}>
          <div style={{ fontWeight: 650 }}>전략로직 상세설정</div>
          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "0.25rem" }}>
            커스텀 · 프리셋 수정
          </div>
        </Link>
      </div>
    </>
  );
}
