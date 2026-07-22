"use client";

import { useEffect, useState } from "react";
import {
  copyPngToClipboard,
  downloadPngBlob,
  renderSharePnlPng,
  type SharePnlPayload,
} from "@/lib/share-pnl";

type Props = {
  open: boolean;
  onClose: () => void;
  today: { returnPct: number; pnlUsd: number };
};

export function SharePnlSheet({ open, onClose, today }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const payload: SharePnlPayload = {
    returnPct: today.returnPct,
    pnlUsd: today.pnlUsd,
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setMsg("");
    (async () => {
      try {
        const blob = await renderSharePnlPng(payload);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      } catch {
        if (!cancelled) setMsg("미리보기를 만들지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, today.returnPct, today.pnlUsd]);

  useEffect(() => {
    if (!open) {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
  }, [open]);

  if (!open) return null;

  async function onCopy() {
    setBusy(true);
    setMsg("");
    try {
      const blob = await renderSharePnlPng(payload);
      const result = await copyPngToClipboard(blob);
      setMsg(
        result === "copied"
          ? "이미지가 클립보드에 복사되었습니다."
          : "이 브라우저는 복사를 지원하지 않아 저장했습니다.",
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "복사 실패");
    }
    setBusy(false);
  }

  async function onSave() {
    setBusy(true);
    setMsg("");
    try {
      const blob = await renderSharePnlPng(payload);
      await downloadPngBlob(blob, "super-alpha-today.png");
      setMsg("이미지를 저장했습니다.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    }
    setBusy(false);
  }

  return (
    <div
      className="share-pnl-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="오늘 수익 공유"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="share-pnl-sheet share-pnl-sheet--compact">
        <div className="share-pnl-head">
          <strong>오늘 수익 공유</strong>
          <button type="button" className="share-pnl-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="share-pnl-preview share-pnl-preview--16x9">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="오늘 수익률 공유 미리보기" />
          ) : (
            <div className="share-pnl-skeleton share-pnl-skeleton--wide">불러오는 중…</div>
          )}
        </div>

        {msg && <p className="share-pnl-msg">{msg}</p>}

        <div className="share-pnl-icons">
          <button type="button" className="share-pnl-icon-btn" disabled={busy} onClick={onCopy}>
            <span className="share-pnl-icon" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <rect x="4" y="4" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </span>
            <em>복사</em>
          </button>
          <button type="button" className="share-pnl-icon-btn" disabled={busy} onClick={onSave}>
            <span className="share-pnl-icon" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 4v10m0 0l4-4m-4 4l-4-4M5 18h14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <em>저장</em>
          </button>
        </div>
      </div>
    </div>
  );
}
