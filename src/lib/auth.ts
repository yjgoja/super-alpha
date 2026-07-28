import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "sa_session";

/** Short session (browser close may clear). */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 12; // 12h
/** Remember-me / 자동로그인 */
export const REMEMBER_MAX_AGE_SEC = 60 * 60 * 24 * 90; // 90d

/**
 * Share session across apex + www (host-only cookies break when users bounce
 * between superalpha.kr and www.superalpha.kr).
 * Override with AUTH_COOKIE_DOMAIN; set empty string to disable.
 * Only apply on *.superalpha.kr — never on *.vercel.app (browser rejects mismatched Domain).
 */
export function sessionCookieDomain(hostHint?: string | null): string | undefined {
  if (process.env.NODE_ENV !== "production") return undefined;
  if (process.env.AUTH_COOKIE_DOMAIN === "") return undefined;
  const d = (process.env.AUTH_COOKIE_DOMAIN || ".superalpha.kr").trim();
  if (!d) return undefined;
  if (hostHint) {
    const host = hostHint.split(":")[0].toLowerCase();
    const ok =
      host === "superalpha.kr" ||
      host.endsWith(".superalpha.kr") ||
      host === d.replace(/^\./, "") ||
      host.endsWith(d.startsWith(".") ? d : `.${d}`);
    if (!ok) return undefined;
  }
  return d;
}

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET missing or too short (min 16 chars)");
    }
    console.warn("AUTH_SECRET missing or too short — using insecure demo fallback (dev only)");
  }
  return new TextEncoder().encode(s || "super-alpha-demo-secret-change-me");
}

export function cookieOptions(opts?: {
  rememberMe?: boolean;
  host?: string | null;
}) {
  const remember = opts?.rememberMe !== false;
  const maxAge = remember ? REMEMBER_MAX_AGE_SEC : SESSION_MAX_AGE_SEC;
  const domain = sessionCookieDomain(opts?.host);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
    // Some mobile browsers honor expires more reliably than maxAge alone.
    expires: new Date(Date.now() + maxAge * 1000),
    ...(domain ? { domain } : {}),
  };
}
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

export async function createSessionToken(
  userId: string,
  opts?: { rememberMe?: boolean },
) {
  const remember = opts?.rememberMe !== false;
  return new SignJWT({ sub: userId, rm: remember ? 1 : 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(remember ? "90d" : "12h")
    .sign(secret());
}

/** Attach session cookie to an API response (required on Vercel/Next Route Handlers). */
export function withSessionCookie(
  res: NextResponse,
  token: string,
  opts?: { rememberMe?: boolean; host?: string | null },
) {
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(opts));
  return res;
}

/** Clear domain cookie and legacy host-only cookie (pre-domain fix). */
export function clearSessionCookie(
  res: NextResponse,
  opts?: { host?: string | null },
) {
  const base = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
  const domain = sessionCookieDomain(opts?.host);
  // Domain cookie (www + apex share)
  if (domain) {
    res.cookies.set(SESSION_COOKIE, "", { ...base, domain });
  }
  // Host-only cookie (legacy / local / vercel.app)
  res.cookies.set(SESSION_COOKIE, "", base);
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
