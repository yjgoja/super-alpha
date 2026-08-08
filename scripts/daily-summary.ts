/**
 * 슈퍼알파 일일요약 — 하루 한 번, 한 통.
 *
 * 문제 알림(monitor-alert.ts)과 역할이 다르다.
 *   - monitor-alert : 문제가 생겼을 때만. 조용한 게 정상.
 *   - daily-summary : 문제가 없어도 매일 한 통. "잘 돌고 있다"를 확인하는 용도.
 *
 * 원래 이 역할을 하던 scripts/lab/daily-report.ts 가 사라져서 새로 만들었다
 * (docs/REMOVED-SCRIPTS.md 참고).
 *
 *   npx tsx --env-file=.env scripts/daily-summary.ts          # 지금 한 번 보내기
 *   npx tsx --env-file=.env scripts/daily-summary.ts --dry    # 보내지 않고 콘솔 출력
 *   npx tsx --env-file=.env scripts/daily-summary.ts --loop   # 매일 정해진 시각에 (PC 상주)
 *
 * 발송 시각은 DAILY_SUMMARY_HOUR_KST (기본 9시).
 */
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { isFxMarketOpen } from "../src/lib/market-hours";

const prisma = new PrismaClient();

const STATE_PATH = path.join(process.cwd(), "scripts", "out", "daily-summary-state.json");
const HOUR_KST = Math.min(23, Math.max(0, Number(process.env.DAILY_SUMMARY_HOUR_KST || 9)));
const DRY = process.argv.includes("--dry");

const kstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const kstDateKey = (d = kstNow()) => d.toISOString().slice(0, 10);
const money = (v: number) =>
  (v < 0 ? "-" : "") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US");

function loadState(): { lastSent?: string } {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: { lastSent?: string }) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (DRY || !token || !chat) {
    if (!DRY) {
      console.warn(
        `[daily] 전송 불가 — ${!token ? "TELEGRAM_BOT_TOKEN" : "TELEGRAM_CHAT_ID"} 가 비어 있습니다. 콘솔에만 출력합니다.`,
      );
    }
    console.log("\n" + text + "\n");
    return !DRY ? false : true;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`[daily] 텔레그램 전송 실패 ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

async function buildSummary(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const L: string[] = [];
  L.push(`📊 슈퍼알파 일일요약 — ${kstDateKey()}`);

  /* 로직공장 */
  const runs = await prisma.logicFactoryRun.findMany({
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  L.push("");
  L.push("🏭 로직공장");
  if (runs.length === 0) {
    L.push("  기록 없음 — 공장이 한 번도 돌지 않았습니다.");
  } else {
    const top = runs[0];
    const ageMin = Math.round((Date.now() - new Date(top.updatedAt).getTime()) / 60000);
    const alive = ageMin < 60;
    L.push(`  ${alive ? "가동 중" : "⚠️ 정지 의심"} · 마지막 저장 ${ageMin}분 전`);
    L.push(`  epoch ${top.epoch} · gen ${top.generation} · 이번 세대 ${top.tested}개 평가`);
    const kind = top.bestLabel?.match(/-N\d+-tp/) ? "발명" : "숫자바꾸기";
    L.push(`  최고점 ${top.bestScore?.toFixed(1) ?? "-"} [${kind}]`);
    if (top.bestLabel) L.push(`  ${top.bestLabel}`);
  }

  /* 승격 */
  const promos = await prisma.logicFactoryPromotion.count({
    where: { createdAt: { gte: since } },
  });
  L.push(`  24시간 승격: ${promos}건${promos === 0 ? " (dry-promote 모드면 정상)" : ""}`);

  /* 엔진 */
  const openBaskets = await prisma.basket.count({ where: { status: "open" } });
  const fills = await prisma.fill.findMany({
    where: { createdAt: { gte: since } },
    select: { pnl: true, kind: true },
  });
  const realized = fills.reduce((s, f) => s + f.pnl, 0);
  const tp = fills.filter((f) => f.kind === "TP").length;
  const sl = fills.filter((f) => f.kind === "SL").length;
  const entries = fills.filter((f) => f.kind === "ENTRY" || f.kind === "DCA").length;
  const lastFill = await prisma.fill.findFirst({ orderBy: { createdAt: "desc" } });
  const fillAgeMin = lastFill
    ? Math.round((Date.now() - new Date(lastFill.createdAt).getTime()) / 60000)
    : null;
  // 폐장(주말·야간)에는 체결이 없는 게 정상이다. 경고로 표시하면 매주 오탐이 난다.
  const marketOpen = isFxMarketOpen();
  const fillStale = fillAgeMin == null || fillAgeMin >= 60;
  L.push("");
  L.push("⚙️ 거래 엔진");
  if (!marketOpen) {
    L.push(`  🌙 폐장 중 · 마지막 체결 ${fillAgeMin ?? "-"}분 전`);
  } else {
    L.push(
      `  ${fillStale ? "⚠️ 체결 없음" : "가동 중"} · 마지막 체결 ${fillAgeMin ?? "-"}분 전`,
    );
  }
  L.push(`  열린 바스켓 ${openBaskets}개`);
  L.push(`  24시간 체결 ${fills.length}건 (진입 ${entries} · 익절 ${tp} · 손절 ${sl})`);
  L.push(`  24시간 실현손익 ${money(realized)}`);

  /* 계좌 */
  const accts = await prisma.brokerAccount.findMany({
    select: { id: true, balance: true, equity: true, liveState: true },
  });
  const live = accts.filter((a) => a.balance > 0);
  const totalBal = live.reduce((s, a) => s + a.balance, 0);
  const totalEq = live.reduce((s, a) => s + a.equity, 0);
  const unreal = totalEq - totalBal;
  L.push("");
  L.push("💰 계좌");
  L.push(`  ${live.length}개 · 잔고 ${money(totalBal)} → 순자산 ${money(totalEq)}`);
  L.push(`  미실현 ${money(unreal)}`);

  const worst = live
    .map((a) => ({ id: a.id, ratio: a.equity / a.balance, bal: a.balance, eq: a.equity }))
    .filter((a) => a.ratio < 0.8)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 3);
  if (worst.length > 0) {
    L.push(`  ⚠️ 평가손실 큰 계좌 ${worst.length}개`);
    for (const a of worst) {
      L.push(`    ${a.id.slice(-8)} ${money(a.bal)} → ${money(a.eq)} (${(a.ratio * 100).toFixed(0)}%)`);
    }
  }

  /* 물량 괴리 */
  let divCount = 0;
  let divMax = 0;
  for (const a of accts) {
    const ls = a.liveState as { positions?: Array<{ symbol?: string; lots?: number }> } | null;
    const pos = ls?.positions;
    if (!Array.isArray(pos) || pos.length === 0) continue;
    const baskets = await prisma.basket.findMany({
      where: { accountId: a.id, status: "open" },
      include: { legs: true },
    });
    for (const b of baskets) {
      const dbLots = b.legs.reduce((s, l) => s + l.lots, 0);
      if (dbLots <= 0) continue;
      const liveLots = pos
        .filter((x) => x.symbol === b.symbol)
        .reduce((s, x) => s + (x.lots ?? 0), 0);
      const diff = liveLots - dbLots;
      if (diff > Math.max(0.02, dbLots * 0.1)) {
        divCount += 1;
        divMax = Math.max(divMax, diff);
      }
    }
  }
  L.push("");
  L.push("🔍 물량 괴리");
  if (divCount === 0) {
    L.push("  없음");
  } else {
    L.push(`  ${divCount}건 (최대 +${divMax.toFixed(2)} lots) · 물타기는 자동 차단 중`);
    L.push("  바스켓이 익절/손절로 닫히면 자연 해소됩니다.");
  }

  return L.join("\n");
}

async function sendOnce() {
  const text = await buildSummary();
  const ok = await sendTelegram(text);
  if (ok && !DRY) console.log(`[daily] 발송 완료 ${kstDateKey()}`);
  return ok;
}

async function loop() {
  console.log(`[daily] 대기 시작 — 매일 KST ${HOUR_KST}시 발송`);
  for (;;) {
    try {
      const now = kstNow();
      const today = kstDateKey(now);
      const state = loadState();
      if (state.lastSent !== today && now.getUTCHours() >= HOUR_KST) {
        const ok = await sendOnce();
        if (ok) saveState({ lastSent: today });
      }
    } catch (e) {
      console.error(`[daily] 요약 실패: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

async function main() {
  if (process.argv.includes("--loop")) return loop();
  const ok = await sendOnce();
  // 1회 실행(GH Actions 등)에서는 실패를 감추지 않는다.
  if (!ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
