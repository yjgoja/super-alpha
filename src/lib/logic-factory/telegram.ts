/**
 * Logic-factory Telegram notifications.
 *
 * Daily digest only — KST noon (default hour 12), once per Seoul calendar day.
 * Never send on every generation / new-high (that spam is explicitly disabled).
 */
import * as fs from "fs";
import * as path from "path";
import { APP_TZ, dayKeySeoul } from "@/lib/day-key";
import { seoulParts } from "@/lib/market-hours";
import { appendAudit, loadLeaderboard } from "./store";

export const FACTORY_TELEGRAM_DAILY_HOUR_KST_DEFAULT = 12;
/** Marker runId in LogicFactoryRun for cross-process once-per-day dedupe. */
export const TELEGRAM_DAILY_MARKER_RUN_ID = "__telegram_daily_marker__";

export function factoryTelegramHourKst(): number {
  const n = Number(process.env.FACTORY_TELEGRAM_HOUR_KST ?? FACTORY_TELEGRAM_DAILY_HOUR_KST_DEFAULT);
  if (!Number.isFinite(n)) return FACTORY_TELEGRAM_DAILY_HOUR_KST_DEFAULT;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

export function telegramConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim(),
  );
}

/** True only inside the configured KST hour (minute irrelevant for window). */
export function isDailyReportHourKst(
  now: Date = new Date(),
  hourKst: number = factoryTelegramHourKst(),
): boolean {
  return seoulParts(now).hour === hourKst;
}

/**
 * Gate: send at most once per Seoul day, and only during the noon hour
 * (unless force=true for explicit CLI/GHA daily job).
 */
export function shouldSendDailyReport(opts: {
  now?: Date;
  lastSentDayKey: string | null | undefined;
  hourKst?: number;
  /** GHA/CLI daily job — skip hour window, still respect day-key unless forceSend. */
  force?: boolean;
  forceSend?: boolean;
}): boolean {
  const now = opts.now ?? new Date();
  const day = dayKeySeoul(now);
  if (opts.forceSend) return true;
  if (opts.lastSentDayKey === day) return false;
  if (opts.force) return true;
  return isDailyReportHourKst(now, opts.hourKst ?? factoryTelegramHourKst());
}

function markerPath(): string {
  return path.join(
    process.cwd(),
    "scripts",
    "out",
    "logic-factory",
    "telegram-daily-sent.json",
  );
}

export function readLocalDailySentDayKey(): string | null {
  try {
    const p = markerPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { dayKey?: string };
    return typeof j.dayKey === "string" ? j.dayKey : null;
  } catch {
    return null;
  }
}

export function writeLocalDailySentDayKey(dayKey: string) {
  const p = markerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ dayKey, sentAt: new Date().toISOString() }, null, 2),
  );
}

async function readDbDailySentDayKey(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.logicFactoryRun.findUnique({
      where: { runId: TELEGRAM_DAILY_MARKER_RUN_ID },
    });
    return row?.bestLabel ?? null;
  } catch {
    return null;
  }
}

async function writeDbDailySentDayKey(dayKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.logicFactoryRun.upsert({
      where: { runId: TELEGRAM_DAILY_MARKER_RUN_ID },
      create: {
        runId: TELEGRAM_DAILY_MARKER_RUN_ID,
        epoch: 0,
        generation: 0,
        tested: 0,
        bestLabel: dayKey,
        bestScore: null,
        status: "telegram_daily",
        leaderboard: { dayKey, kind: "telegram_daily_marker" },
      },
      update: {
        bestLabel: dayKey,
        status: "telegram_daily",
        leaderboard: { dayKey, kind: "telegram_daily_marker" },
      },
    });
  } catch (e) {
    appendAudit(`TELEGRAM_MARKER_DB_SKIP ${(e as Error).message}`);
  }
}

export async function resolveLastDailySentDayKey(): Promise<string | null> {
  const db = await readDbDailySentDayKey();
  if (db) return db;
  return readLocalDailySentDayKey();
}

export async function markDailySent(dayKey: string): Promise<void> {
  writeLocalDailySentDayKey(dayKey);
  await writeDbDailySentDayKey(dayKey);
}

export type DailyReportPayload = {
  dayKey: string;
  text: string;
};

export function formatDailyReportText(opts?: {
  now?: Date;
  board?: ReturnType<typeof loadLeaderboard> | null;
  dbExtra?: {
    runId?: string;
    epoch?: number;
    generation?: number;
    tested?: number;
    bestScore?: number | null;
    bestLabel?: string | null;
    updatedAt?: Date | string | null;
  } | null;
}): DailyReportPayload {
  const now = opts?.now ?? new Date();
  const dayKey = dayKeySeoul(now);
  const parts = seoulParts(now);
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");

  const board = opts?.board ?? loadLeaderboard();
  const db = opts?.dbExtra;

  const runId = db?.runId || board?.runId || "(none)";
  const bestLabel = db?.bestLabel ?? board?.bestLabel ?? null;
  const bestScore =
    db?.bestScore ??
    (typeof board?.bestScore === "number" ? board.bestScore : null);
  const tested =
    typeof db?.tested === "number"
      ? db.tested
      : typeof (board as { tested?: number } | null)?.tested === "number"
        ? (board as { tested: number }).tested
        : null;
  const epoch =
    typeof db?.epoch === "number"
      ? db.epoch
      : typeof (board as { epoch?: number } | null)?.epoch === "number"
        ? (board as { epoch: number }).epoch
        : null;
  const generation =
    typeof db?.generation === "number"
      ? db.generation
      : typeof (board as { generation?: number } | null)?.generation === "number"
        ? (board as { generation: number }).generation
        : null;

  const top = (board as { top?: Array<Record<string, unknown>> } | null)?.top;
  const topLines =
    Array.isArray(top) && top.length
      ? top.slice(0, 5).map((t, i) => {
          const label = String(t.label ?? t.id ?? "?");
          const score =
            typeof t.score === "number" ? t.score.toFixed(3) : String(t.score ?? "-");
          const sym = t.symbol ? ` · ${t.symbol}` : "";
          return `${i + 1}. ${label}${sym} · score=${score}`;
        })
      : ["(상위 후보 없음)"];

  const lines = [
    `📊 로직공장 일일보고 · ${dayKey} ${hh}:${mm} KST`,
    `※ 하루 1회(정오) · 세대마다 알림 없음`,
    ``,
    `run ${runId}`,
    epoch != null || generation != null
      ? `epoch ${epoch ?? "-"} · 세대 ${generation ?? "-"}` +
        (tested != null ? ` · 테스트 ${tested.toLocaleString("en-US")}` : "")
      : tested != null
        ? `테스트 ${tested.toLocaleString("en-US")}`
        : `리더보드 갱신 대기`,
    bestLabel
      ? `최고 ${bestLabel}` +
        (bestScore != null && Number.isFinite(bestScore)
          ? ` · score=${bestScore.toFixed(3)}`
          : "")
      : `최고 기록 없음`,
    ``,
    `TOP5`,
    ...topLines,
    ``,
    `TZ=${APP_TZ} · hourGate=${factoryTelegramHourKst()}`,
  ];

  return { dayKey, text: lines.join("\n") };
}

export async function sendTelegramMessage(text: string): Promise<{
  ok: boolean;
  reason?: string;
  status?: number;
}> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    return { ok: false, reason: "TELEGRAM_BOT_TOKEN/CHAT_ID missing" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `HTTP ${res.status} ${body.slice(0, 200)}`,
        status: res.status,
      };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Maybe send the once-daily KST noon digest.
 * Continuous factory must call this without force — hour + day-key gate.
 * GHA daily job should pass force:true (still day-key unless forceSend).
 */
export async function maybeSendFactoryDailyTelegram(opts?: {
  now?: Date;
  force?: boolean;
  forceSend?: boolean;
  /** When true, skip Telegram HTTP (unit/verify). */
  dryRun?: boolean;
}): Promise<{
  sent: boolean;
  skipped: boolean;
  reason: string;
  dayKey: string;
  text?: string;
}> {
  const now = opts?.now ?? new Date();
  const dayKey = dayKeySeoul(now);

  // Hard off for per-generation / new-high spam (env must not re-enable continuous).
  if (process.env.FACTORY_TELEGRAM_ON_NEW_HIGH === "1") {
    appendAudit("TELEGRAM_NEW_HIGH_IGNORED — daily-only policy");
  }

  if (process.env.FACTORY_TELEGRAM_DAILY === "0") {
    return { sent: false, skipped: true, reason: "FACTORY_TELEGRAM_DAILY=0", dayKey };
  }

  if (!opts?.dryRun && !telegramConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "telegram not configured",
      dayKey,
    };
  }

  const last = await resolveLastDailySentDayKey();
  if (
    !shouldSendDailyReport({
      now,
      lastSentDayKey: last,
      force: opts?.force,
      forceSend: opts?.forceSend,
    })
  ) {
    const reason =
      last === dayKey
        ? `already sent ${dayKey}`
        : `outside KST hour ${factoryTelegramHourKst()} (now=${seoulParts(now).hour})`;
    return { sent: false, skipped: true, reason, dayKey };
  }

  let dbExtra: {
    runId?: string;
    epoch?: number;
    generation?: number;
    tested?: number;
    bestScore?: number | null;
    bestLabel?: string | null;
    updatedAt?: Date | string | null;
  } | null = null;

  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import("@/lib/db");
      const row = await prisma.logicFactoryRun.findFirst({
        where: { runId: { not: TELEGRAM_DAILY_MARKER_RUN_ID } },
        orderBy: { updatedAt: "desc" },
      });
      if (row) {
        dbExtra = {
          runId: row.runId,
          epoch: row.epoch,
          generation: row.generation,
          tested: row.tested,
          bestScore: row.bestScore,
          bestLabel: row.bestLabel,
          updatedAt: row.updatedAt,
        };
      }
    } catch {
      dbExtra = null;
    }
  }

  const payload = formatDailyReportText({ now, dbExtra });

  if (opts?.dryRun) {
    return {
      sent: false,
      skipped: true,
      reason: "dryRun",
      dayKey: payload.dayKey,
      text: payload.text,
    };
  }

  const send = await sendTelegramMessage(payload.text);
  if (!send.ok) {
    appendAudit(`TELEGRAM_DAILY_FAIL ${send.reason}`);
    return {
      sent: false,
      skipped: false,
      reason: send.reason || "send failed",
      dayKey: payload.dayKey,
      text: payload.text,
    };
  }

  await markDailySent(payload.dayKey);
  appendAudit(`TELEGRAM_DAILY_OK ${payload.dayKey}`);
  return {
    sent: true,
    skipped: false,
    reason: "ok",
    dayKey: payload.dayKey,
    text: payload.text,
  };
}
