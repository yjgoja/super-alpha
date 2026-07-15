/**
 * Simulates /api/me + post-login routing for key users (no HTTP session).
 */
import { PrismaClient } from "@prisma/client";
import { resolvePostLoginPath, brokerGateRedirect } from "../src/lib/post-login";

const prisma = new PrismaClient();

async function simulateMe(email: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (!user) {
    console.log({ email, error: "not found" });
    return;
  }
  const account = await prisma.brokerAccount.findFirst({
    where: { userId: user.id },
    select: {
      id: true,
      login: true,
      status: true,
      metaApiAccountId: true,
      botEnabled: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const hasBrokerAccount = !!account;
  const next = resolvePostLoginPath({
    role: user.role,
    approvalStatus: user.approvalStatus,
    hasBrokerAccount,
  });
  const traderGate = brokerGateRedirect({
    role: user.role,
    metaApiAccountId: account?.metaApiAccountId,
  });
  console.log(
    JSON.stringify(
      {
        email: user.email,
        role: user.role,
        approvalStatus: user.approvalStatus,
        hasBrokerAccount,
        account,
        loginNext: next,
        traderPageRedirect: traderGate,
      },
      null,
      2,
    ),
  );
}

async function main() {
  for (const email of ["yjgoja@gmail.com", "master", "test@test.com"]) {
    await simulateMe(email);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
