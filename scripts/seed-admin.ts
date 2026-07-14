import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAILS || "yjgoja@gmail.com")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD env required (min 8 chars) — refuse hardcoded defaults");
  }
  const passwordHash = await hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: "Admin",
      passwordHash,
      role: "admin",
      approvalStatus: "approved",
    },
    update: {
      passwordHash,
      role: "admin",
      approvalStatus: "approved",
    },
  });

  const tables = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`;

  console.log(
    JSON.stringify(
      {
        ok: true,
        adminEmail: user.email,
        adminId: user.id,
        role: user.role,
        approvalStatus: user.approvalStatus,
        seedPasswordSet: true,
        tables: tables.map((t) => t.tablename),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
