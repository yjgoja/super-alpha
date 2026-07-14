import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  withSessionCookie,
} from "@/lib/auth";
import { autoApproveUsers, isAdminEmail } from "@/lib/access";
import { prisma } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z
    .string()
    .trim()
    .email("올바른 이메일을 입력하세요.")
    .max(120),
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상이어야 합니다.")
    .max(72),
  name: z.string().trim().max(60).optional(),
  mode: z.enum(["login", "register"]),
});

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "입력값을 확인하세요.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    const body = parsed.data;
    const email = body.email.toLowerCase();

    if (body.mode === "register") {
      const rl = rateLimit(`register:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
      if (!rl.ok) {
        return NextResponse.json(
          { error: `가입 요청이 너무 많습니다. ${rl.retryAfterSec}초 후 다시 시도하세요.` },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
      }
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        return NextResponse.json({ error: "이미 가입된 이메일입니다." }, { status: 400 });
      }
      const admin = isAdminEmail(email);
      const approved = admin || autoApproveUsers();
      const user = await prisma.user.create({
        data: {
          email,
          name: body.name || email.split("@")[0],
          passwordHash: await hashPassword(body.password),
          role: admin ? "admin" : "user",
          approvalStatus: approved ? "approved" : "pending",
        },
      });
      const token = await createSessionToken(user.id);
      return withSessionCookie(
        NextResponse.json({
          ok: true,
          userId: user.id,
          approvalStatus: user.approvalStatus,
        }),
        token,
      );
    }

    const rlLogin = rateLimit(`login:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 });
    if (!rlLogin.ok) {
      return NextResponse.json(
        { error: `로그인 시도가 너무 많습니다. ${rlLogin.retryAfterSec}초 후 다시 시도하세요.` },
        { status: 429, headers: { "Retry-After": String(rlLogin.retryAfterSec) } },
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json(
        { error: "이메일 또는 비밀번호가 올바르지 않습니다." },
        { status: 401 },
      );
    }
    if (user.approvalStatus === "rejected") {
      return NextResponse.json(
        { error: "관리자에 의해 이용이 거절된 계정입니다." },
        { status: 403 },
      );
    }
    const token = await createSessionToken(user.id);
    return withSessionCookie(
      NextResponse.json({
        ok: true,
        userId: user.id,
        approvalStatus: user.approvalStatus,
      }),
      token,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "요청 오류";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
