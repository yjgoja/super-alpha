/**
 * 로직공장 일일 보고 — 매일 밤 텔레그램으로.
 *
 * 옛 공장(scripts/lab/)의 일일 보고를 지금 공장 데이터로 되살린 것이다.
 * 원본에 있던 시드별 요약(6종)·리베이트·주말노출은 지금 공장이 계산하지 않아
 * 빠져 있다 (docs/REMOVED-SCRIPTS.md 참고).
 *
 *   npx tsx --env-file=.env scripts/factory-daily-report.ts         # 지금 한 번
 *   npx tsx --env-file=.env scripts/factory-daily-report.ts --dry   # 출력만
 *   npx tsx --env-file=.env scripts/factory-daily-report.ts --loop  # 매일 정해진 시각
 *
 * 발송 시각 FACTORY_REPORT_HOUR_KST (기본 0 = 자정).
 *
 * 에폭 파일이 6천 개를 넘어 매번 전부 읽으면 431MB 를 훑게 된다. 그래서
 * 명예의 전당(HOF)을 상태 파일로 유지하고 새 세대만 증분 반영한다.
 */
import * as fs from "fs";
import * as path from "path";

const RUN_ROOT = path.join(process.cwd(), "scripts", "out", "logic-factory");
const STATE_PATH = path.join(RUN_ROOT, "hall-of-fame.json");
const HOUR_KST = Math.min(23, Math.max(0, Number(process.env.FACTORY_REPORT_HOUR_KST || 0)));
const HOF_KEEP = Math.max(10, Number(process.env.FACTORY_HOF_KEEP || 60));
const DRY = process.argv.includes("--dry");

/** 관문 — 이걸 통과해야 순위 대상. 낙폭은 관문으로만 쓰고 순위엔 안 쓴다. */
const GATE_MAX_DD = Number(process.env.FACTORY_GATE_MAX_DD || 50);
/** 합격 = 월 5% 이상, 최상위 = 월 10% 이상 (월초 잔고 대비 중앙값) */
const GRADE_TOP = 10;
const GRADE_PASS = 5;

type MonthStat = {
  month: string;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
};
type Metrics = {
  seed: number;
  finalEquity: number;
  totalReturnPct: number;
  medianMonthReturnPct: number;
  consistency: number;
  maxDrawdownPct: number;
  tpCount: number;
  slCount: number;
  tpUsd: number;
  slUsd: number;
  months: MonthStat[];
  score: number;
};
type Bot = {
  logic: string;
  direction: string;
  dualDirection?: boolean;
  startLots: number;
  entryCount: number;
  entryMultiplier: number;
  takeProfitPct: number;
  stopLossPct: number;
};
type Cand = {
  id: string;
  kind: string;
  label: string;
  symbol: string;
  direction: string;
  dualDirection?: boolean;
  levels?: unknown[];
  bot?: Bot;
  metrics: Metrics;
};
type Epoch = { runId: string; epoch: number; generation: number; tested: number; top: Cand[] };
type State = {
  runId: string;
  lastGen: number;
  totalTested: number;
  firstSeenMs: number;
  hof: Cand[];
};

const kstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const kstStamp = () => {
  const d = kstNow();
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} KST`;
};
const dateKey = () => kstNow().toISOString().slice(0, 10);
const pad = (s: string | number, n: number, left = false) => {
  const v = String(s);
  // 한글은 2칸 폭으로 계산해야 표가 안 어긋난다.
  const w = [...v].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, n - w));
  return left ? fill + v : v + fill;
};
const sign = (v: number, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d);

function currentRunDir(): string | null {
  try {
    const dirs = fs
      .readdirSync(RUN_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("run-"))
      .map((d) => ({ name: d.name, t: fs.statSync(path.join(RUN_ROOT, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return dirs.length ? path.join(RUN_ROOT, dirs[0].name) : null;
  } catch {
    return null;
  }
}

function loadState(): State | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return null;
  }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

/** 관문: 낙폭 상한, 최소 1회 거래, 월별 데이터 존재 */
function passesGate(c: Cand): boolean {
  const m = c.metrics;
  if (!m || !Array.isArray(m.months) || m.months.length === 0) return false;
  if (m.maxDrawdownPct > GATE_MAX_DD) return false;
  if (m.tpCount + m.slCount <= 0) return false;
  if (!Number.isFinite(m.score)) return false;
  return true;
}

function grade(c: Cand): "최상위" | "합격" | "미달" {
  const r = c.metrics.medianMonthReturnPct;
  if (r >= GRADE_TOP) return "최상위";
  if (r >= GRADE_PASS) return "합격";
  return "미달";
}

/** 새 세대만 읽어 명예의 전당에 반영한다. */
function refreshHof(): State {
  const dir = currentRunDir();
  if (!dir) throw new Error("공장 산출물 디렉토리를 찾지 못했습니다.");

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("epoch-") && f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/epoch-(\d+)-gen-(\d+)\.json/);
      return m ? { f, epoch: Number(m[1]), gen: Number(m[2]) } : null;
    })
    .filter((x): x is { f: string; epoch: number; gen: number } => x !== null)
    .sort((a, b) => a.gen - b.gen);

  const runId = path.basename(dir);
  let state = loadState();
  if (!state || state.runId !== runId) {
    // 탐색 경과는 이 스크립트를 처음 돌린 시각이 아니라 공장이 시작한 시각이어야 한다.
    // runId 가 run-2026-08-07T13-41-29 형태라 거기서 뽑는다.
    const m = runId.match(/^run-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
    const startedMs = m
      ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
      : Date.now();
    state = {
      runId,
      lastGen: 0,
      totalTested: 0,
      firstSeenMs: Number.isFinite(startedMs) ? startedMs : Date.now(),
      hof: [],
    };
    console.log(`[report] 새 run 감지 (${runId}) — 전체 ${files.length}세대 스캔`);
  }

  const fresh = files.filter((x) => x.gen > state!.lastGen);
  if (fresh.length === 0) {
    console.log(`[report] 새 세대 없음 (lastGen=${state.lastGen})`);
    return state;
  }
  console.log(`[report] 새 세대 ${fresh.length}개 반영 중...`);

  const byId = new Map<string, Cand>(state.hof.map((c) => [c.id, c]));
  let tested = state.totalTested;
  let maxGen = state.lastGen;

  for (const { f, gen } of fresh) {
    let ep: Epoch;
    try {
      ep = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Epoch;
    } catch {
      continue;
    }
    tested += ep.tested || 0;
    maxGen = Math.max(maxGen, gen);
    for (const c of ep.top || []) {
      if (!passesGate(c)) continue;
      const prev = byId.get(c.id);
      if (!prev || c.metrics.score > prev.metrics.score) byId.set(c.id, c);
    }
  }

  const hof = [...byId.values()]
    .sort((a, b) => b.metrics.score - a.metrics.score)
    .slice(0, HOF_KEEP);

  const next: State = {
    runId,
    lastGen: maxGen,
    totalTested: tested,
    firstSeenMs: state.firstSeenMs,
    hof,
  };
  saveState(next);
  console.log(`[report] HOF ${hof.length}개 · 누적 테스트 ${tested.toLocaleString()}개`);
  return next;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}일 ${h}시간 ${m}분`;
}

function rankTable(hof: Cand[]): string {
  const L: string[] = [];
  L.push("월수익률% = 월별 중앙값, 월초 잔고 대비");
  L.push(
    `  # ${pad("로직명", 24)} ${pad("심볼", 8)} ${pad("등급", 8)} ${pad("월수익률%", 10, true)} ${pad("일관성", 7, true)} ${pad("점수", 8, true)} ${pad("월거래", 7, true)}`,
  );
  L.push("-".repeat(84));
  hof.slice(0, 10).forEach((c, i) => {
    const m = c.metrics;
    const label = c.label.length > 23 ? c.label.slice(0, 22) + "…" : c.label;
    const perMonth = m.months.length ? (m.tpCount + m.slCount) / m.months.length : 0;
    L.push(
      `${pad(i + 1, 3, true)} ${pad(label, 24)} ${pad(c.symbol, 8)} ${pad(grade(c), 8)} ${pad(sign(m.medianMonthReturnPct), 10, true)} ${pad(m.consistency.toFixed(3), 7, true)} ${pad(m.score.toFixed(3), 8, true)} ${pad(perMonth.toFixed(1), 7, true)}`,
    );
  });
  return L.join("\n");
}

function monthTable(c: Cand): string {
  const L: string[] = [];
  L.push("수익률% 기준: 월초 잔고 대비");
  L.push(
    `${pad("월", 10)} ${pad("수익률%", 10, true)} ${pad("익절금액$", 13, true)} ${pad("손절금액$", 13, true)} ${pad("익절", 6, true)} ${pad("손절", 6, true)}`,
  );
  L.push("-".repeat(64));
  for (const m of c.metrics.months) {
    L.push(
      `${pad(m.month, 10)} ${pad(sign(m.returnPct), 10, true)} ${pad(sign(m.tpUsd), 13, true)} ${pad(sign(-Math.abs(m.slUsd)), 13, true)} ${pad(m.tpCount, 6, true)} ${pad(m.slCount, 6, true)}`,
    );
  }
  const tot = c.metrics;
  L.push("-".repeat(64));
  L.push(
    `${pad("합계", 10)} ${pad(sign(tot.totalReturnPct), 10, true)} ${pad(sign(tot.tpUsd), 13, true)} ${pad(sign(-Math.abs(tot.slUsd)), 13, true)} ${pad(tot.tpCount, 6, true)} ${pad(tot.slCount, 6, true)}`,
  );
  return L.join("\n");
}

function logicSpec(c: Cand): string {
  const b = c.bot;
  if (!b) return "(설정 정보 없음)";
  const L: string[] = [];
  L.push(`회차 N=${b.entryCount} (초기 진입 포함) · 사다리 ${c.levels?.length ?? "-"}단`);
  L.push(
    `로트 산정 0회차 ${b.startLots}랏, 회차 배수 m=${b.entryMultiplier} (lot_i = ${b.startLots}×${b.entryMultiplier}^i)`,
  );
  L.push(`익절 ${b.takeProfitPct}% · 손절 ${b.stopLossPct}% (증거금 대비 ROI)`);
  L.push(`기반 프리셋 ${b.logic} · 방향 ${b.dualDirection ? "DUAL" : b.direction}`);
  L.push(`종류 ${c.kind === "novel_ladder" ? "발명(유전 알고리즘)" : "숫자바꾸기(프리셋 변형)"}`);
  return L.join("\n");
}

function buildReport(state: State): string[] {
  const hof = state.hof;
  const passed = hof.filter((c) => grade(c) !== "미달");
  const top = hof.filter((c) => grade(c) === "최상위");

  const head: string[] = [];
  head.push(`🌙 로직공장 일일 보고 · ${kstStamp()}`);
  head.push(
    `지금까지 테스트한 로직 ${state.totalTested.toLocaleString()}개 · 탐색 경과 ${elapsed(Date.now() - state.firstSeenMs)} · 관문 통과 ${hof.length}개 · 합격(월 ${GRADE_PASS}% 이상) ${passed.length}개 · 최상위(월 ${GRADE_TOP}% 이상) ${top.length}개`,
  );
  head.push(`run=\`${state.runId}\``);
  head.push("");
  head.push("🏁 순위");
  head.push("```");
  head.push(rankTable(hof));
  head.push("```");

  const parts: string[] = [head.join("\n")];

  hof.slice(0, 3).forEach((c, i) => {
    const m = c.metrics;
    const win = m.months.filter((x) => x.returnPct > 0).length;
    const L: string[] = [];
    L.push(`${i + 1}위 · ${c.label} · ${c.symbol} [${grade(c)}]`);
    L.push(`id=\`${c.id}\``);
    L.push(
      `${grade(c)} · 시드 $${m.seed.toLocaleString()} 월 ${sign(m.medianMonthReturnPct)}% · 일관성 ${m.consistency.toFixed(3)} · 점수 ${m.score.toFixed(3)} · 최대 낙폭 ${m.maxDrawdownPct.toFixed(1)}%`,
    );
    L.push(
      `월별 상세 — 수익월 ${win}/${m.months.length} · 최종 잔고 $${Math.round(m.finalEquity).toLocaleString()}`,
    );
    L.push("```");
    L.push(monthTable(c));
    L.push("```");
    L.push("📌 로직 간단설명");
    L.push("```");
    L.push(logicSpec(c));
    L.push("```");
    parts.push(L.join("\n"));
  });

  const tail: string[] = [];
  tail.push("⚠️ 주의");
  tail.push("```");
  tail.push("· 발굴 결과는 봇에 자동 적용되지 않는다 (dry-promote 모드).");
  tail.push("· 낙폭은 관문(최고 잔고 대비 50% 이내)으로만 쓰고 순위 기준으로는 쓰지 않는다.");
  tail.push("  낙폭으로 순위를 매기면 거래를 하지 않는 전략이 1등이 된다.");
  tail.push("· 월별 수익률은 월초 잔고 대비 중앙값이다.");
  tail.push("· 스왑·리베이트 미반영. 슬리피지 미반영.");
  tail.push(
    "· 옛 보고서에 있던 시드 6종 요약·리베이트·주말노출은 현재 공장이 계산하지 않아 빠져 있다.",
  );
  tail.push(`· run=${state.runId} · 마지막 세대 ${state.lastGen}`);
  tail.push("```");
  parts.push(tail.join("\n"));

  return parts;
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (DRY || !token || !chat) {
    if (!DRY) {
      console.warn(
        `[report] 전송 불가 — ${!token ? "TELEGRAM_BOT_TOKEN" : "TELEGRAM_CHAT_ID"} 가 비어 있습니다.`,
      );
    }
    console.log("\n" + text + "\n" + "─".repeat(60));
    return DRY;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error(`[report] 전송 실패 ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

/** 텔레그램 4096자 제한. 코드블록이 잘리지 않도록 파트 단위로만 나눈다. */
async function sendParts(parts: string[]) {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.length <= 3800) {
      chunks.push(p);
      continue;
    }
    // 지나치게 긴 파트는 줄 단위로 쪼갠다 (코드블록은 각 조각에서 다시 연다)
    const lines = p.split("\n");
    let buf: string[] = [];
    let inCode = false;
    for (const line of lines) {
      if (line.trim() === "```") inCode = !inCode;
      buf.push(line);
      if (buf.join("\n").length > 3400 && !inCode) {
        chunks.push(buf.join("\n"));
        buf = [];
      }
    }
    if (buf.length) chunks.push(buf.join("\n"));
  }
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1 ? `📄 (${i + 1}/${chunks.length})\n` : "";
    if (!(await sendTelegram(label + chunks[i]))) ok = false;
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return ok;
}

async function runOnce() {
  const state = refreshHof();
  if (state.hof.length === 0) {
    console.log("[report] 관문을 통과한 후보가 없습니다 — 보고 생략");
    return true;
  }
  return sendParts(buildReport(state));
}

async function loop() {
  const SENT = path.join(RUN_ROOT, "daily-report-sent.json");
  console.log(`[report] 대기 시작 — 매일 KST ${HOUR_KST}시 발송`);
  for (;;) {
    try {
      const today = dateKey();
      let last = "";
      try {
        last = JSON.parse(fs.readFileSync(SENT, "utf8")).lastSent ?? "";
      } catch {
        /* 최초 실행 */
      }
      if (last !== today && kstNow().getUTCHours() >= HOUR_KST) {
        if (await runOnce()) {
          fs.writeFileSync(SENT, JSON.stringify({ lastSent: today }, null, 2));
          console.log(`[report] 발송 완료 ${today}`);
        }
      }
    } catch (e) {
      console.error(`[report] 보고 실패: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 10 * 60_000));
  }
}

async function main() {
  if (process.argv.includes("--loop")) return loop();
  if (!(await runOnce())) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
