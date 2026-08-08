/**
 * 감시 알림 긴급 중지 (테스트용)
 */
import * as fs from "fs";

const envPath = ".env";
let env = fs.readFileSync(envPath, "utf8");

// 텔레그램 토큰을 공백으로 설정 (알림 비활성화)
env = env.replace(
  /TELEGRAM_BOT_TOKEN=.*/,
  'TELEGRAM_BOT_TOKEN=' // 공백
);
env = env.replace(
  /TELEGRAM_CHAT_ID=.*/,
  'TELEGRAM_CHAT_ID=' // 공백
);

fs.writeFileSync(envPath, env);
console.log("✅ 텔레그램 알림 비활성화 (토큰 제거)");
