import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, approvalStatus: true },
  });
  console.log("neon_users", JSON.stringify(users, null, 2));
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
