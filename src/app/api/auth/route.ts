import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashPassword, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(4),
  name: z.string().optional(),
  mode: z.enum(["login", "register"]),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();

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
      await createSession(user.id);
      return NextResponse.json({ ok: true, userId: user.id });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
    }
    await createSession(user.id);
    return NextResponse.json({ ok: true, userId: user.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "요청 오류";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
