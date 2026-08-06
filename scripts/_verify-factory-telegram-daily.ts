/**
 * Offline QA: factory Telegram daily report gates (KST noon, once/day).
 * No network / no MetaAPI.
 */
import {
  FACTORY_TELEGRAM_DAILY_HOUR_KST_DEFAULT,
  formatDailyReportText,
  isDailyReportHourKst,
  shouldSendDailyReport,
} from "../src/lib/logic-factory";

let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Build a Date whose Asia/Seoul wall clock is the given Y-M-D H:M. */
function seoulWall(y: number, mo: number, d: number, h: number, mi: number): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(
    `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+09:00`,
  );
}

function main() {
  assert("default hour is 12", FACTORY_TELEGRAM_DAILY_HOUR_KST_DEFAULT === 12);

  const noon = seoulWall(2026, 8, 4, 12, 5);
  const morning = seoulWall(2026, 8, 4, 11, 59);
  const afternoon = seoulWall(2026, 8, 4, 13, 0);
  const midnight = seoulWall(2026, 8, 4, 0, 0);

  assert("noon is report hour", isDailyReportHourKst(noon, 12));
  assert("morning is not report hour", !isDailyReportHourKst(morning, 12));
  assert("afternoon is not report hour", !isDailyReportHourKst(afternoon, 12));
  assert("midnight is not report hour", !isDailyReportHourKst(midnight, 12));

  assert(
    "send at noon when never sent",
    shouldSendDailyReport({ now: noon, lastSentDayKey: null, hourKst: 12 }),
  );
  assert(
    "no send morning",
    !shouldSendDailyReport({ now: morning, lastSentDayKey: null, hourKst: 12 }),
  );
  assert(
    "no send afternoon",
    !shouldSendDailyReport({ now: afternoon, lastSentDayKey: null, hourKst: 12 }),
  );
  assert(
    "no duplicate same day at noon",
    !shouldSendDailyReport({
      now: noon,
      lastSentDayKey: "2026-08-04",
      hourKst: 12,
    }),
  );
  assert(
    "next day noon ok",
    shouldSendDailyReport({
      now: seoulWall(2026, 8, 5, 12, 1),
      lastSentDayKey: "2026-08-04",
      hourKst: 12,
    }),
  );
  assert(
    "force skips hour but respects day key",
    shouldSendDailyReport({
      now: morning,
      lastSentDayKey: null,
      force: true,
    }) &&
      !shouldSendDailyReport({
        now: morning,
        lastSentDayKey: "2026-08-04",
        force: true,
      }),
  );
  assert(
    "forceSend always",
    shouldSendDailyReport({
      now: morning,
      lastSentDayKey: "2026-08-04",
      forceSend: true,
    }),
  );

  // Continuous spam regression: many ticks outside noon must never gate-open.
  let spam = 0;
  for (let h = 0; h < 24; h++) {
    if (h === 12) continue;
    if (
      shouldSendDailyReport({
        now: seoulWall(2026, 8, 4, h, 30),
        lastSentDayKey: null,
        hourKst: 12,
      })
    ) {
      spam += 1;
    }
  }
  assert("no send any non-noon hour", spam === 0, `spam=${spam}`);

  // Same noon hour, already sent → still blocked (continuous worker every 15s).
  let noonSpam = 0;
  for (let i = 0; i < 20; i++) {
    if (
      shouldSendDailyReport({
        now: seoulWall(2026, 8, 4, 12, i),
        lastSentDayKey: "2026-08-04",
        hourKst: 12,
      })
    ) {
      noonSpam += 1;
    }
  }
  assert("noon hour dedupe across ticks", noonSpam === 0, `noonSpam=${noonSpam}`);

  const text = formatDailyReportText({
    now: noon,
    board: {
      runId: "verify-run",
      bestScore: 1.23,
      bestLabel: "TEST-LABEL",
    },
  });
  assert("report title", text.text.includes("로직공장 일일보고"));
  assert("report says once daily", text.text.includes("하루 1회"));
  assert("report dayKey", text.dayKey === "2026-08-04");

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nAll factory telegram daily gates passed.");
}

main();
