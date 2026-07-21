import { prisma } from "../src/lib/db";

async function main() {
  const r = await prisma.brokerAccount.updateMany({
    data: { tickLockedAt: null },
  });
  console.log("cleared tick locks", r.count);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
