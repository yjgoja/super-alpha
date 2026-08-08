/**
 * 로직공장 발견 알림 — 신기록이 나오면 텔레그램으로 한 통.
 *
 * 옛 공장(scripts/lab/)이 하던 일이다. driver-state.json 에 남은
 * notify.lastAnnouncedRecordKey 가 그 흔적인데, 시스템이 통째로 사라지면서
 * 2026-08-03 이후 알림이 끊겼다 (docs/REMOVED-SCRIPTS.md 참고).
 *
 * 지금 공장(scripts/logic-factory-run.ts)에는 알림 코드가 없어서, 공장 코드를
 * 건드리지 않고 산출물(LATEST.json)만 지켜보는 별도 프로세스로 되살린다.
 *
 *   npx tsx --env-file=.env scripts/factory-notify.ts          # 지금 한 번 확인
 *   npx tsx --env-file=.env scripts/factory-notify.ts --dry    # 보내지 않고 출력
 *   npx tsx --env-file=.env scripts/factory-notify.ts --loop   # 상주 감시
 *
 * 스팸 방지: 직전 알린 기록을 넘어서야 하고, 최소 점수와 최소 개선폭을 둘 다 만족해야 한다.
 *   FACTORY_NOTIFY_MIN_SCORE   기본 100
 *   FACTORY_NOTIFY_MIN_GAIN    기본 3 (%)
 */
import * as fs from "fs";
import * as path from "path";

const LATEST = path.join(process.cwd(), "scripts", "out", "logic-factory", "LATEST.json");
const STATE_PATH = path.join(process.cwd(), "scripts", "out", "factory-notify-state.json");
const MIN_SCORE = Number(process.env.FACTORY_NOTIFY_MIN_SCORE || 100);
const MIN_GAIN_PCT = Number(process.env.FACTORY_NOTIFY_MIN_GAIN || 3);
const POLL_MS = Math.max(60_000, Number(process.env.FACTORY_NOTIFY_POLL_MS || 300_000));
const DRY = process.argv.includes("--dry");

type Top = {
  id: string;
  kind: string;
  label: string;
  score: number;
  medianMonthReturnPct: number;
  consistency: number;
  maxDrawdownPct: number;
  symbol: string;
  direction: string;
};
type Latest = {
  runId: string;
  epoch: number;
  generation: number;
  tested: number;
  bestLabel: string;
  bestScore: number;
  updatedAt: string;
  top: Top[];
};
type State = { bestScore?: number; bestLabel?: string; announcedAt?: string };

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function readLatest(): Latest | null {
  try {
    return JSON.parse(fs.readFileSync(LATEST, "utf8")) as Latest;
  } catch {
    return null;
  }
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (DRY || !token || !chat) {
    if (!DRY) {
      console.warn(
        `[factory-notify] 전송 불가 — ${!token ? "TELEGRAM_BOT_TOKEN" : "TELEGRAM_CHAT_ID"} 가 비어 있습니다. 콘솔에만 출력합니다.`,
      );
    }
    console.log("\n" + text + "\n");
    return DRY;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`[factory-notify] 전송 실패 ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

function format(best: Top, latest: Latest, prev?: number): string {
  const kind = best.kind === "novel_ladder" ? "🧬 발명" : "🔢 숫자바꾸기";
  const L: string[] = [];
  L.push(`🏆 로직공장 신기록`);
  L.push("");
  L.push(`${best.symbol} ${best.direction} · ${kind}`);
  L.push(`점수 ${best.score.toFixed(1)}${prev ? ` (이전 ${prev.toFixed(1)})` : ""}`);
  L.push("");
  L.push(`월 수익률(중앙값) ${best.medianMonthReturnPct.toFixed(1)}%`);
  L.push(`최대 낙폭 ${best.maxDrawdownPct.toFixed(1)}%`);
  L.push(`일관성 ${best.consistency}`);
  L.push("");
  L.push(`${best.label}`);
  L.push(`epoch ${latest.epoch} · gen ${latest.generation}`);
  L.push("");
  L.push(`※ dry-promote 모드면 실계좌에 자동 반영되지 않습니다.`);
  return L.join("\n");
}

async function checkOnce(): Promise<boolean> {
  const latest = readLatest();
  if (!latest || !Array.isArray(latest.top) || latest.top.length === 0) {
    console.log("[factory-notify] LATEST.json 없음 또는 비어 있음 — 공장이 아직 안 돌았습니다.");
    return false;
  }
  const best = latest.top.reduce((a, b) => (b.score > a.score ? b : a));
  const state = loadState();
  const prev = state.bestScore ?? 0;

  if (best.score < MIN_SCORE) {
    console.log(
      `[factory-notify] 최고점 ${best.score.toFixed(1)} < 최소기준 ${MIN_SCORE} — 알리지 않음`,
    );
    return false;
  }
  const needed = prev * (1 + MIN_GAIN_PCT / 100);
  if (prev > 0 && best.score <= needed) {
    console.log(
      `[factory-notify] 최고점 ${best.score.toFixed(1)} — 직전 기록 ${prev.toFixed(1)} 대비 ${MIN_GAIN_PCT}% 개선 미달, 알리지 않음`,
    );
    return false;
  }

  const ok = await sendTelegram(format(best, latest, prev > 0 ? prev : undefined));
  // --dry 는 미리보기다. 상태를 저장하면 다음 실제 실행에서 이 기록을 건너뛴다.
  if (ok && !DRY) {
    saveState({
      bestScore: best.score,
      bestLabel: best.label,
      announcedAt: new Date().toISOString(),
    });
    console.log(`[factory-notify] 신기록 알림: ${best.label} ${best.score.toFixed(1)}`);
  }
  return ok;
}

async function main() {
  if (!process.argv.includes("--loop")) {
    const ok = await checkOnce();
    if (!ok && !DRY) process.exitCode = 0; // 알릴 게 없는 것은 실패가 아니다
    return;
  }
  console.log(
    `[factory-notify] 감시 시작 — ${Math.round(POLL_MS / 60000)}분마다 · 최소점수 ${MIN_SCORE} · 최소개선 ${MIN_GAIN_PCT}%`,
  );
  for (;;) {
    try {
      await checkOnce();
    } catch (e) {
      console.error(`[factory-notify] 확인 실패: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
