import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  withSessionCookie,
} from "@/lib/auth";
import { prisma } from "@/lib/db";

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
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "입력값을 확인하세요.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    const body = parsed.data;
    const email = body.email.toLowerCase();

    if (body.mode === "register") {
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        return NextResponse.json({ error: "이미 가입된 이메일입니다." }, { status: 400 });
      }
      const user = await prisma.user.create({
        data: {
          email,
          name: body.name || email.split("@")[0],
          passwordHash: await hashPassword(body.password),
        },
      });
      const token = await createSessionToken(user.id);
      return withSessionCookie(
        NextResponse.json({ ok: true, userId: user.id }),
        token,
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json(
        { error: "이메일 또는 비밀번호가 올바르지 않습니다." },
        { status: 401 },
      );
    }
    const token = await createSessionToken(user.id);
    return withSessionCookie(
      NextResponse.json({ ok: true, userId: user.id }),
      token,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "요청 오류";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
