import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  return clearSessionCookie(NextResponse.json({ ok: true }), {
    host: req.headers.get("host"),
  });
}
