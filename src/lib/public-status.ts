/**
 * User-facing account status — never surface MetaAPI 429 / network / retry noise.
 */
const ALARM_RE =
  /요청 한도|rate\s*limit|429|toomany|네트워크|network|timeout|econnreset|fetch failed|unstable|잠시 후|다시 시도|자동 재시도|시세를 가져오지|일부 종목 오류|주문에 실패|trade context busy/i;

export function isAlarmStatusMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return ALARM_RE.test(msg);
}

/** Sanitize for member UI (manage / market / live). */
export function publicBotStatusMessage(input: {
  botEnabled: boolean;
  status?: string | null;
  statusMessage?: string | null;
}): string {
  const raw = (input.statusMessage || "").trim();
  if (!input.botEnabled) {
    if (raw && !isAlarmStatusMessage(raw)) return raw;
    return "봇 중지 · 열린 포지션 익절·손절만 관리";
  }
  if (raw && !isAlarmStatusMessage(raw)) return raw;
  if (input.status === "undeployed") return "클라우드 대기 · 봇 실행 중";
  return "클라우드 연결 · 봇 실행 중";
}
