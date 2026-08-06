/**
 * Logic-factory Telegram 일일보고 — KST 정오 1회 전용.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/logic-factory-daily-report.ts
 *   npx tsx scripts/logic-factory-daily-report.ts --force   # GHA noon job (day-key still applies)
 *   npx tsx scripts/logic-factory-daily-report.ts --force-send --dry-run
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   FACTORY_TELEGRAM_HOUR_KST=12
 *   FACTORY_TELEGRAM_DAILY=1|0
 */
import { maybeSendFactoryDailyTelegram } from "../src/lib/logic-factory";

function flag(name: string) {
  return process.argv.includes(name);
}

async function main() {
  const force = flag("--force") || flag("--force-daily");
  const forceSend = flag("--force-send");
  const dryRun = flag("--dry-run");

  const result = await maybeSendFactoryDailyTelegram({
    force,
    forceSend,
    dryRun,
  });

  console.log(
    JSON.stringify(
      {
        sent: result.sent,
        skipped: result.skipped,
        reason: result.reason,
        dayKey: result.dayKey,
        preview: result.text ? result.text.slice(0, 400) : undefined,
      },
      null,
      2,
    ),
  );

  // Missing telegram config is soft-ok for CI without secrets.
  if (!result.sent && result.reason === "telegram not configured") {
    process.exit(0);
  }
  if (!result.sent && !result.skipped && result.reason !== "dryRun") {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
