// 폐장시간 감시 알림 비활성화 스크립트
import * as fs from "fs";
import * as path from "path";

const statePath = path.join("scripts", "out", "monitor-state.json");
const disablePath = path.join("scripts", "out", "monitor-disabled.txt");

try {
  // 감시 상태 파일 제거 (알림 재시작)
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
    console.log("✅ 감시 상태 제거됨");
  }
  
  // 비활성화 플래그 설정
  fs.writeFileSync(disablePath, "MONITOR_DISABLED=true\nDISABLED_AT=" + new Date().toISOString());
  console.log("✅ 감시 알림 비활성화됨");
  console.log("   파일: scripts/out/monitor-disabled.txt");
} catch (e) {
  console.error("❌ 오류:", e.message);
}
