"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Href = { label: string; href: string };
type Project = {
  id: string;
  name: string;
  kind: string;
  summary: string;
  hrefs: Href[];
  cursorPrompts: string[];
  commands?: string[];
};

export default function RemoteOpsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const me = await fetch("/api/me").then((r) => r.json()).catch(() => ({}));
    if (me.error || me.role !== "admin") {
      window.location.href = "/login";
      return;
    }
    const res = await fetch("/api/admin/remote-ops", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(data.error || "불러오기 실패");
      setReady(true);
      return;
    }
    setProjects(data.projects || []);
    setNote(data.note || "");
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setErr("클립보드 복사 실패 — 길게 눌러 복사하세요.");
    }
  }

  return (
    <div className="m-page">
      <header className="m-top">
        <Link href="/mypage" className="m-back">
          ← 마이페이지
        </Link>
        <h1>원격 지시 센터</h1>
      </header>

      <section className="m-card" style={{ marginBottom: "0.85rem" }}>
        <div style={{ fontWeight: 700 }}>폰에서 전 프로젝트 지시</div>
        <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.5 }}>
          앱 버튼으로 트레이딩을 고치고, 블로그·팩토리·엔진은 아래 문구를{" "}
          <strong>Cursor 앱</strong>에 붙여 넣으면 PC(private worker)가 실행합니다.
        </p>
        {note ? (
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.75rem", color: "var(--gold)", lineHeight: 1.45 }}>
            {note}
          </p>
        ) : null}
      </section>

      {!ready && <p style={{ color: "var(--muted)" }}>불러오는 중…</p>}
      {err && (
        <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{err}</p>
      )}
      {copied && (
        <p style={{ color: "var(--ok, #0a7)", fontSize: "0.8rem", marginBottom: "0.55rem" }}>
          복사됨: {copied.slice(0, 48)}
          {copied.length > 48 ? "…" : ""}
        </p>
      )}

      <div style={{ display: "grid", gap: "0.75rem" }}>
        {projects.map((p) => (
          <section key={p.id} className="m-card">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <div style={{ fontWeight: 700 }}>{p.name}</div>
              <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{p.kind}</span>
            </div>
            <p style={{ margin: "0.4rem 0 0.65rem", fontSize: "0.78rem", color: "var(--muted)", lineHeight: 1.45 }}>
              {p.summary}
            </p>

            {p.hrefs.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.65rem" }}>
                {p.hrefs.map((h) => (
                  <Link
                    key={h.href}
                    href={h.href}
                    className="sa-btn sa-btn-primary"
                    style={{
                      fontSize: "0.78rem",
                      padding: "0.45rem 0.7rem",
                      borderRadius: 10,
                      textDecoration: "none",
                    }}
                  >
                    {h.label}
                  </Link>
                ))}
              </div>
            )}

            <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginBottom: "0.35rem" }}>
              Cursor에 보낼 지시 (탭하면 복사)
            </div>
            <div style={{ display: "grid", gap: "0.35rem" }}>
              {p.cursorPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="sa-btn sa-btn-ghost"
                  style={{
                    textAlign: "left",
                    borderRadius: 10,
                    padding: "0.65rem 0.75rem",
                    fontSize: "0.82rem",
                    lineHeight: 1.4,
                  }}
                  onClick={() => void copyText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>

            {p.commands && p.commands.length > 0 && (
              <details style={{ marginTop: "0.65rem" }}>
                <summary style={{ fontSize: "0.75rem", color: "var(--muted)", cursor: "pointer" }}>
                  직접 명령어
                </summary>
                <div style={{ display: "grid", gap: "0.3rem", marginTop: "0.45rem" }}>
                  {p.commands.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      style={{
                        textAlign: "left",
                        borderRadius: 8,
                        padding: "0.45rem 0.55rem",
                        fontSize: "0.7rem",
                        fontFamily: "ui-monospace, monospace",
                        wordBreak: "break-all",
                      }}
                      onClick={() => void copyText(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
