import fs from "fs";
import path from "path";
import { createRequire } from "module";

function loadEnv() {
  const p = path.join(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const bots = await prisma.symbolBot.findMany();
  for (const b of bots) {
    if (b.takeProfitPct > 0 && b.takeProfitPct <= 5) {
      const next = Math.round(b.takeProfitPct * 20 * 100) / 100;
      await prisma.symbolBot.update({ where: { id: b.id }, data: { takeProfitPct: next } });
      console.log("migrated", b.symbol, b.takeProfitPct, "->", next);
    } else {
      console.log("ok", b.symbol, "tpRoi", b.takeProfitPct);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
