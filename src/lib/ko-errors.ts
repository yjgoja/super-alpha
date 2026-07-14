/**
 * Convert MetaAPI / system English errors into clean Korean user messages.
 * Never show raw English + UUID junk to admins/users.
 */
export function toKoreanError(raw: unknown, fallback = "요청 처리 중 오류가 났습니다."): string {
  const text = extractText(raw);
  if (!text) return fallback;

  const lower = text.toLowerCase();

  if (
    lower.includes("top up") ||
    lower.includes("high reliability") ||
    lower.includes("please top up")
  ) {
    return "MetaAPI 계정 잔액이 부족합니다. 고신뢰(high) 모드는 충전 후 사용 가능합니다. 일반 모드로 자동 재시도합니다.";
  }
  if (lower.includes("e_auth") || lower.includes("invalid account") || lower.includes("authentication")) {
    return "MT5 계좌번호 또는 비밀번호가 올바르지 않습니다.";
  }
  if (lower.includes("e_srv_not_found") || lower.includes("server") && lower.includes("not found")) {
    return "MT5 서버명을 MetaAPI에서 찾지 못했습니다. ZeroMarkets-1 설정을 확인하세요.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "브로커 연결 시간이 초과되었습니다. 잠시 후 다시 승인해주세요.";
  }
  if (lower.includes("no_token") || lower.includes("metaapi_token") || lower.includes("unauthorized")) {
    return "로그인이 필요하거나 MetaAPI 토큰 설정이 없습니다.";
  }
  if (lower.includes("forbidden")) {
    return "권한이 없습니다.";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  }
  if (lower.includes("insufficient") && lower.includes("margin")) {
    return "증거금이 부족합니다.";
  }
  if (lower.includes("market is closed") || lower.includes("trade is disabled")) {
    return "현재 해당 종목 거래가 불가능합니다(장 마감 등).";
  }
  if (lower.includes("deploy") && lower.includes("fail")) {
    return "클라우드 서버 배포에 실패했습니다. 계좌 정보를 확인 후 다시 승인하세요.";
  }
  if (lower.includes("network") || lower.includes("fetch failed")) {
    return "네트워크 오류입니다. 잠시 후 다시 시도하세요.";
  }

  // Strip UUID / hex noise like (d2dc0656...)
  const cleaned = text
    .replace(/\([0-9a-f]{8,}\)/gi, "")
    .replace(/\b[0-9a-f]{32}\b/gi, "")
    .trim();

  // If still mostly English technical junk, use fallback
  if (/^[A-Za-z0-9\s.,'"_:/\-()]+$/.test(cleaned) && cleaned.length > 40) {
    return fallback;
  }

  // Prefer Korean-looking strings as-is
  if (/[가-힣]/.test(cleaned)) return cleaned;

  return fallback;
}

export function gateErrorKo(code: string | null | undefined) {
  switch (code) {
    case "unauthorized":
      return "로그인이 필요합니다.";
    case "forbidden":
      return "관리자 권한이 필요합니다.";
    case "rejected":
      return "관리자에 의해 이용이 거절된 계정입니다.";
    case "pending_approval":
      return "승인 대기 중입니다.";
    default:
      return "요청을 처리할 수 없습니다.";
  }
}

function extractText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
    if (typeof o.details === "string") return o.details;
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return String(raw);
}

export function isTopUpOrHighReliabilityError(raw: unknown) {
  const t = extractText(raw).toLowerCase();
  return t.includes("top up") || t.includes("high reliability");
}
