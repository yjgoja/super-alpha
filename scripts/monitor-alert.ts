/**
 * 슈퍼알파 감시 알림 — DB만 읽고 텔레그램으로 통보한다.
 *
 * 거래 경로(meta-engine)를 건드리지 않는 독립 프로세스다. 2026-08-08에
 * 브로커/DB 물량 괴리가 3배까지 벌어지도록 아무 신호가 없었던 것이 계기.
 *
 *   npx tsx --env-file=.env scripts/monitor-alert.ts          # 1회 점검
 *   npx tsx --env-file=.env scripts/monitor-alert.ts --loop   # 반복
 *
 * 스팸 방지: 같은 문제는 재알림하지 않고, 해소되면 복구 알림을 한 번 보낸다.
 */
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { isFxMarketOpen, isWeeklyMarketClosed } from "../src/lib/market-hours";

const prisma = new PrismaClient();

const STATE_PATH = path.join(process.cwd(), "scripts", "out", "monitor-state.json");
const INTERVAL_MS = Math.max(60_000, Number(process.env.MONITOR_INTERVAL_MS || 600_000));

/** 물량 괴리 허용치 — meta-engine 의 shouldBlockDcaForLotDivergence 와 같은 기준. */
const LOT_TOLERANCE = (ladder: number) => Math.max(0.02, ladder * 0.1);
/** 엔진이 이 시간 넘게 아무 계좌도 틱하지 않으면 죽은 것으로 본다. */
const ENGINE_STALE_MS = Math.max(300_000, Number(process.env.MONITOR_ENGINE_STALE_MS || 900_000));
/** 공장이 이 시간 넘게 세대를 저장하지 않으면 멈춘 것으로 본다. */
const FACTORY_STALE_MS = Math.max(600_000, Number(process.env.MONITOR_FACTORY_STALE_MS || 3_600_000));
/** 순자산이 잔고 대비 이 비율 밑이면 경고. */
const EQUITY_FLOOR = Number(process.env.MONITOR_EQUITY_FLOOR || 0.6);

type Alert = { key: string; text: string };

function loadState(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveState(s: Record<string, number>) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) {
    console.warn("[monitor] TELEGRAM_BOT_TOKEN/CHAT_ID 없음 — 콘솔에만 출력");
    console.log(text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`[monitor] 텔레그램 전송 실패 ${res.status}: ${await res.text()}`);
  }
}

/** 브로커가 DB보다 많은 물량을 들고 있는 바스켓. */
async function checkLotDivergence(): Promise<Alert[]> {
  const accts = await prisma.brokerAccount.findMany({
    select: { id: true, liveState: true, equity: true },
  });
  const out: Alert[] = [];
  for (const a of accts) {
    const live = a.liveState as {
      positions?: Array<{ symbol?: string; direction?: string; lots?: number }>;
    } | null;
    const positions = live?.positions;
    if (!Array.isArray(positions) || positions.length === 0) continue;

    const baskets = await prisma.basket.findMany({
      where: { accountId: a.id, status: "open" },
      include: { legs: true },
    });
    for (const b of baskets) {
      const dbLots = b.legs.reduce((s, l) => s + l.lots, 0);
      // 방향까지 일치해야 한다 — 양방향(dualDirection) 계좌에서 심볼만으로
      // 합치면 반대방향 물량이 섞여 가짜 괴리로 보인다 (2026-08-08 오탐 2건).
      const liveLots = positions
        .filter((x) => x.symbol === b.symbol && (!x.direction || x.direction === b.direction))
        .reduce((s, x) => s + (x.lots ?? 0), 0);
      if (dbLots <= 0) continue;
      const diff = liveLots - dbLots;
      if (diff > LOT_TOLERANCE(dbLots)) {
        out.push({
          key: `lot:${b.id}`,
          text:
            `🔴 물량 괴리\n계좌 ${a.id.slice(-10)} ${b.symbol} ${b.direction}\n` +
            `DB ${dbLots.toFixed(2)} / 브로커 ${liveLots.toFixed(2)} lots (+${diff.toFixed(2)})\n` +
            `미실현 ${b.unrealizedPnl.toFixed(0)} · 물타기는 자동 차단됨`,
        });
      }
    }
  }
  return out;
}

/** 엔진이 최근에 어떤 계좌든 틱했는지 (tickLockedAt / 최근 체결). */
async function checkEngineAlive(): Promise<Alert[]> {
  const since = new Date(Date.now() - ENGINE_STALE_MS);
  const locked = await prisma.brokerAccount.count({ where: { tickLockedAt: { not: null } } });
  const recentFill = await prisma.fill.findFirst({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });
  if (locked === 0 && !recentFill) {
    return [
      {
        key: "engine:dead",
        text:
          `🔴 엔진 정지 의심\n최근 ${Math.round(ENGINE_STALE_MS / 60000)}분간 tick lock 0건, 체결 0건.\n` +
          `Render super-alpha-engine 상태를 확인하세요.`,
      },
    ];
  }
  return [];
}

/** 로직공장이 세대를 계속 저장하고 있는지. */
async function checkFactoryAlive(): Promise<Alert[]> {
  const last = await prisma.logicFactoryRun.findFirst({ orderBy: { updatedAt: "desc" } });
  if (!last) {
    return [{ key: "factory:none", text: "⚠️ 로직공장 기록이 하나도 없습니다." }];
  }
  const ageMs = Date.now() - new Date(last.updatedAt).getTime();
  if (ageMs > FACTORY_STALE_MS) {
    return [
      {
        key: "factory:stale",
        text:
          `⚠️ 로직공장 정지 의심\n마지막 저장 ${Math.round(ageMs / 60000)}분 전 ` +
          `(epoch ${last.epoch} gen ${last.generation}).\nPC의 start-factory.ps1 을 확인하세요.`,
      },
    ];
  }
  return [];
}

/** 순자산이 잔고 대비 크게 깎인 계좌. */
async function checkDrawdown(): Promise<Alert[]> {
  const accts = await prisma.brokerAccount.findMany({
    select: { id: true, balance: true, equity: true },
  });
  const out: Alert[] = [];
  for (const a of accts) {
    if (a.balance <= 0) continue;
    const ratio = a.equity / a.balance;
    if (ratio < EQUITY_FLOOR) {
      out.push({
        key: `dd:${a.id}`,
        text:
          `🔴 큰 평가손실\n계좌 ${a.id.slice(-10)}\n` +
          `잔고 ${a.balance.toFixed(0)} → 순자산 ${a.equity.toFixed(0)} (${(ratio * 100).toFixed(0)}%)`,
      });
    }
  }
  return out;
}

async function runOnce() {
  // 긴급 비활성화 체크 (MONITOR_ALERT_DISABLE_UNTIL 설정됨)
  const disableUntil = process.env.MONITOR_ALERT_DISABLE_UNTIL;
  if (disableUntil) {
    const until = new Date(disableUntil);
    if (Date.now() < until.getTime()) {
      // 비활성화 중: 상태 파일 초기화 (스팸 방지)
      saveState({});
      const kst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      const stamp = kst.toLocaleString("ko-KR");
      console.log(`🔇 [monitor] ${stamp} — 긴급 알림 비활성화 (${until.toISOString()}까지) + 상태 초기화`);
      return; // 완전 비활성화
    }
  }

  // 폐장시간 체크 (주말/공휴일/야간 등)
  const isWeeklyClosed = isWeeklyMarketClosed();
  const isFxOpen = isFxMarketOpen();
  const isMarketClosed = isWeeklyClosed || !isFxOpen;

  if (isMarketClosed) {
    const kst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
    const stamp = kst.toLocaleString("ko-KR");
    console.log(`🌙 [monitor] ${stamp} — 폐장시간 — 심각 문제만 알림`);
  }

  const alerts: Alert[] = [
    ...(await checkEngineAlive()),
    ...(await checkFactoryAlive()),
    ...(await checkLotDivergence()),
    ...(await checkDrawdown()),
  ];

  // 폐장시간 필터링: 심각한 문제는 계속 알림 (엔진 정지 제외 — 폐장 중 정상)
  let filteredAlerts = alerts;
  if (isMarketClosed) {
    // 물량 괴리, 큰 손실, 공장 정지만 폐장 중에도 알림
    // engine:dead는 폐장 중 정상이므로 무시 (월~금 9시에 자동 시작됨)
    filteredAlerts = alerts.filter(a =>
      a.key.includes("lot:") ||         // 물량 괴리 — 실제 거래 오류
      a.key.includes("dd:") ||          // 큰 평가손실 — 실제 손실
      a.key.includes("factory:stale")   // 공장 정지 — PC 확인 필요
      // engine:dead는 폐장 중 정상이므로 필터링
    );
    const skipped = alerts.length - filteredAlerts.length;
    if (skipped > 0) {
      console.log(`🌙 [monitor] 폐장시간: ${skipped}건 알림 필터링 (엔진 정지 등 폐장 정상)`);
    }
  }

  const state = loadState();
  const now = Date.now();
  const active = new Set(filteredAlerts.map((a) => a.key));

  // 한 통으로 묶어 보낸다.
  // 문제마다 따로 보내던 탓에 최초 실행에서 9통이 한꺼번에 갔고,
  // 그래서 알림을 통째로 꺼두게 됐다. 새 문제는 모아서 1통, 해소도 1통.
  const fresh = filteredAlerts.filter((a) => !state[a.key]);
  if (fresh.length > 0) {
    const head =
      fresh.length === 1 ? "🔔 슈퍼알파 알림" : `🔔 슈퍼알파 알림 — 새 문제 ${fresh.length}건`;
    await sendTelegram([head, "", ...fresh.map((a) => a.text)].join("\n\n"));
    for (const a of fresh) state[a.key] = now;
    console.log(`[monitor] 알림 발송: ${fresh.map((a) => a.key).join(", ")}`);
  }

  const resolved = Object.keys(state).filter((k) => !active.has(k));
  if (resolved.length > 0) {
    await sendTelegram(
      [`✅ 해소됨 ${resolved.length}건`, "", ...resolved.map((k) => `· ${k}`)].join("\n"),
    );
    for (const k of resolved) delete state[k];
    console.log(`[monitor] 해소: ${resolved.join(", ")}`);
  }

  saveState(state);
  const stamp = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[monitor] ${stamp} 점검 완료 — 문제 ${alerts.length}건`);
}

async function main() {
  const loop = process.argv.includes("--loop");
  if (process.argv.includes("--test")) {
    await sendTelegram("🔔 슈퍼알파 감시 알림 연결 테스트입니다.");
    return;
  }
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error(`[monitor] 점검 실패: ${(e as Error).message}`);
    }
    if (!loop) return;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
