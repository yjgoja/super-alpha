/**
 * 고아가 된(stale) tick lock 만 정리한다.
 *
 * 예전에는 where 절 없이 전체를 NULL 로 만들었다. 살아 있는 Render 워커의
 * 락까지 날려서 두 인스턴스가 같은 계좌를 동시에 틱하게 만드는 코드였고,
 * CLAUDE.md 가 명시적으로 금지한 것이다("이걸 무조건 초기화하는 코드를
 * 절대 넣지 말 것"). tick-direct.ts 의 clearStaleTickLocks 와 같은 기준을 쓴다.
 *
 *   npx tsx --env-file=.env scripts/_clear-tick-lock.ts
 *   npx tsx --env-file=.env scripts/_clear-tick-lock.ts --stale-ms 300000
 */
import { prisma } from "../src/lib/db";

function argNum(name: string, fallback: number) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main() {
  const staleMs = argNum(
    "--stale-ms",
    Math.max(90_000, Number(process.env.ENGINE_TICK_LOCK_STALE_MS || 180_000)),
  );
  const staleBefore = new Date(Date.now() - staleMs);

  const held = await prisma.brokerAccount.count({
    where: { tickLockedAt: { not: null } },
  });
  const r = await prisma.brokerAccount.updateMany({
    where: { tickLockedAt: { lt: staleBefore } },
    data: { tickLockedAt: null },
  });

  console.log(
    `tick lock: 보유 ${held}건 중 stale(${Math.round(staleMs / 1000)}초 초과) ${r.count}건 정리`,
  );
  if (held > r.count) {
    console.log(
      `살아있는 락 ${held - r.count}건은 건드리지 않았다 — 다른 인스턴스가 지금 틱 중이다.`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
