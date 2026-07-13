import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "sa_session";

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    // still allow, but warn in logs
    console.warn("AUTH_SECRET missing or too short");
  }
  return new TextEncoder().encode(s || "super-alpha-demo-secret-change-me");
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  if (!hash) return false;
  // bcrypt hashes start with $2
  if (hash.startsWith("$2")) {
    return bcrypt.compare(password, hash);
  }
  // legacy base64 demo encoding
  try {
    const decoded = Buffer.from(hash, "base64").toString("utf8");
    return decoded === password;
  } catch {
    return false;
  }
}

export async function createSessionToken(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
}

/** Attach session cookie to an API response (required on Vercel/Next Route Handlers). */
export function withSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, cookieOptions);
  return res;
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return res;
}

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
