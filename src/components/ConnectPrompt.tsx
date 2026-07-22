"use client";

import { useRouter } from "next/navigation";

/** Soft gate: ask to link MT5 before trading actions. */
export function ConnectPrompt({
  open,
  onClose,
  title = "실계좌 연결이 필요합니다",
  body = "봇 시작·매매·청산은 MT5 실계좌 연결 후 이용할 수 있습니다.",
  mode = "connect",
}: {
  open: boolean;
  onClose?: () => void;
  title?: string;
  body?: string;
  mode?: "connect" | "approval";
}) {
  const router = useRouter();
  if (!open) return null;

  const isApproval = mode === "approval";
  const heading = isApproval ? "관리자 승인이 필요합니다" : title;
  const text = isApproval
    ? "관리자가 회원 승인을 완료한 뒤 봇·매매·실계좌 연결을 이용할 수 있습니다."
    : body;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-prompt-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        padding: "1rem",
      }}
      onClick={() => onClose?.()}
    >
      <div
        className="m-card"
        style={{
          width: "100%",
          maxWidth: 420,
          marginBottom: "3.5rem",
          borderRadius: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="connect-prompt-title" style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>
          {heading}
        </h2>
        <p style={{ margin: "0.65rem 0 1.1rem", fontSize: "0.88rem", color: "var(--muted)", lineHeight: 1.5 }}>
          {text}
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {onClose && (
            <button
              type="button"
              className="sa-btn sa-btn-ghost"
              style={{ flex: 1, borderRadius: 12, padding: "0.75rem" }}
              onClick={onClose}
            >
              확인
            </button>
          )}
          {!isApproval && (
            <button
              type="button"
              className="sa-btn sa-btn-primary"
              style={{ flex: 1, borderRadius: 12, padding: "0.75rem" }}
              onClick={() => router.push("/connect")}
            >
              실계좌 연결하기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AccountLinkBadge({
  linked,
  approvalStatus,
  accountStatus,
}: {
  linked: boolean;
  approvalStatus?: string | null;
  accountStatus?: string | null;
}) {
  if (approvalStatus && approvalStatus !== "approved" && approvalStatus !== "rejected") {
    return (
      <span
        style={{
          display: "inline-block",
          marginLeft: "0.45rem",
          padding: "0.15rem 0.45rem",
          borderRadius: 999,
          fontSize: "0.68rem",
          fontWeight: 650,
          verticalAlign: "middle",
          color: "var(--gold, #c9a227)",
          background: "rgba(201,162,39,0.12)",
          border: "1px solid rgba(201,162,39,0.35)",
        }}
      >
        승인 대기
      </span>
    );
  }
  if (
    accountStatus === "pending_registration" ||
    accountStatus === "provisioning"
  ) {
    return (
      <span
        style={{
          display: "inline-block",
          marginLeft: "0.45rem",
          padding: "0.15rem 0.45rem",
          borderRadius: 999,
          fontSize: "0.68rem",
          fontWeight: 650,
          verticalAlign: "middle",
          color: "var(--gold, #c9a227)",
          background: "rgba(201,162,39,0.12)",
          border: "1px solid rgba(201,162,39,0.35)",
        }}
      >
        연동 신청 중
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: "0.45rem",
        padding: "0.15rem 0.45rem",
        borderRadius: 999,
        fontSize: "0.68rem",
        fontWeight: 650,
        verticalAlign: "middle",
        color: linked ? "var(--ok, #0a7)" : "var(--muted)",
        background: linked ? "rgba(10,170,120,0.12)" : "rgba(255,255,255,0.06)",
        border: linked ? "1px solid rgba(10,170,120,0.35)" : "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {linked ? "실계좌 연동됨" : "실계좌 연동 전"}
    </span>
  );
}

export function isMt5Linked(account?: {
  metaApiAccountId?: string | null;
  status?: string | null;
} | null) {
  return Boolean(account?.metaApiAccountId);
}
