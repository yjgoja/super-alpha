/**
 * 공개 프리셋 봇의 잘못된 stopLossPct(예: 1250) → 표 기본값으로 교정
 * + yjgoja 잔고 고갈 상태면 XAU 봇 OFF (진입 스팸 방지)
 */
import { prisma } from "../src/lib/db";
import { normalizeLogicId } from "../src/lib/strategies";
import {
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";

async function main() {
  const bots = await prisma.symbolBot.findMany();
  let fixed = 0;
  for (const b of bots) {
    const logic = normalizeLogicId(b.logic);
    if (logic === "custom") continue;
    const wantSl = resolveLiveStopLossPct(logic, b.stopLossPct);
    const wantTp = resolveLiveTakeProfitPct(logic, b.takeProfitPct);
    const needLogic = b.logic !== logic;
    const needSl = Math.abs(b.stopLossPct - wantSl) > 0.01;
    const needTp =
      logic.startsWith("martin_9_") && Math.abs(b.takeProfitPct - wantTp) > 0.01;
    if (!needLogic && !needSl && !needTp) continue;
    await prisma.symbolBot.update({
      where: { id: b.id },
      data: {
        ...(needLogic ? { logic } : {}),
        ...(needSl ? { stopLossPct: wantSl, stopLossEnabled: true } : {}),
        ...(needTp ? { takeProfitPct: wantTp } : {}),
      },
    });
    fixed++;
    console.log(
      `fix ${b.symbol} ${b.direction}: ${b.logic}/${b.stopLossPct} → ${logic}/${wantSl}`,
    );
  }
  console.log("fixed bots", fixed);

  const u = await prisma.user.findFirst({
    where: { email: "yjgoja@gmail.com" },
    include: { accounts: true },
  });
  if (!u) return;
  for (const a of u.accounts) {
    if (a.equity < 50) {
      await prisma.symbolBot.updateMany({
        where: { accountId: a.id, enabled: true },
        data: { enabled: false },
      });
      await prisma.brokerAccount.update({
        where: { id: a.id },
        data: {
          botEnabled: false,
          statusMessage: "잔고 부족 · 봇 자동 중지 (손절% 교정 완료, 입금 후 재시작)",
        },
      });
      console.log("disabled yjgoja bots — equity", a.equity);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
