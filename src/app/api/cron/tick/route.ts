import { NextResponse } from "next/server";
import { runAllBots } from "@/lib/meta-engine";
import { undeployIdleAccounts } from "@/lib/cost-optimize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const isVercelCron = req.headers.get("x-vercel-cron") === "1";
  // Prefer Authorization header; query ?secret= accepted for legacy but avoid logging URLs with it
  const url = new URL(req.url);
  const q = url.searchParams.get("secret");
  const ok =
    (secret && auth === `Bearer ${secret}`) ||
    (secret && q === secret) ||
    (isVercelCron && !!secret);
  if (!ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const idle = await undeployIdleAccounts(24);
  const results = await runAllBots();
  return NextResponse.json({
    ok: true,
    count: results.length,
    results,
    idleUndeploy: idle,
  });
}
