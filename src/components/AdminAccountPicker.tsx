"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sa-admin-edit-accountId";

export type AdminEditAccount = {
  id: string;
  label: string;
  login: string;
  email: string;
  botEnabled: boolean;
  status: string;
  openBaskets: number;
  equity: number;
};

type Props = {
  value: string | null;
  onChange: (accountId: string | null) => void;
};

export function readStoredAdminEditAccountId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function writeStoredAdminEditAccountId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Admin-only: pick any MT5 account to edit remotely (phone Cursor / away). */
export function AdminAccountPicker({ value, onChange }: Props) {
  const [accounts, setAccounts] = useState<AdminEditAccount[]>([]);
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/accounts", { cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      setReady(true);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(data.error || "계좌 목록 실패");
      setReady(true);
      return;
    }
    const list = (data.accounts || []) as AdminEditAccount[];
    setAccounts(list);
    setReady(true);
    if (value && !list.some((a) => a.id === value)) {
      onChange(null);
      writeStoredAdminEditAccountId(null);
    }
  }, [value, onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) {
    return (
      <section className="m-card" style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.82rem", color: "var(--muted)" }}>원격 편집 계좌 불러오는 중…</div>
      </section>
    );
  }

  if (accounts.length === 0 && !err) return null;

  const selected = accounts.find((a) => a.id === value) || null;

  return (
    <section className="m-card" style={{ marginBottom: "0.75rem" }}>
      <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>원격 편집 계좌</div>
      <p style={{ margin: "0 0 0.55rem", fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.45 }}>
        외부(폰)에서도 PC처럼 아무 계좌나 골라 수정합니다. 비우면 내 활성 계좌입니다.
      </p>
      <select
        className="sa-input"
        value={value || ""}
        onChange={(e) => {
          const next = e.target.value || null;
          writeStoredAdminEditAccountId(next);
          onChange(next);
        }}
      >
        <option value="">내 활성 계좌</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.email} · {a.label}
            {a.botEnabled ? " · BOT" : ""}
            {a.openBaskets > 0 ? ` · 바스켓${a.openBaskets}` : ""}
          </option>
        ))}
      </select>
      {selected && (
        <div style={{ marginTop: "0.45rem", fontSize: "0.78rem", color: "var(--muted)" }}>
          MT5 {selected.login} · {selected.status} · ${selected.equity.toFixed(2)}
        </div>
      )}
      {err && (
        <p style={{ margin: "0.45rem 0 0", color: "var(--danger)", fontSize: "0.8rem" }}>{err}</p>
      )}
    </section>
  );
}
