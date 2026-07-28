import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  cookieOptions,
  verifySessionToken,
} from "@/lib/auth";

const CANONICAL_HOST = "www.superalpha.kr";
const APEX_HOST = "superalpha.kr";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/connect",
  "/settings",
  "/home",
  "/bot",
  "/market",
  "/manage",
  "/mypage",
  "/admin",
] as const;

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase() || "";

  // Keep apex + www on one host so session cookies stay valid after reopen.
  if (host === APEX_HOST) {
    const url = req.nextUrl.clone();
    url.host = CANONICAL_HOST;
    url.protocol = "https:";
    return NextResponse.redirect(url, 308);
  }

  if (!isProtectedPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const userId = await verifySessionToken(token);
  if (!userId) {
    const res = NextResponse.redirect(new URL("/login", req.url));
    const cleared = {
      ...cookieOptions({ rememberMe: true, host }),
      maxAge: 0,
      expires: new Date(0),
    };
    res.cookies.set(SESSION_COOKIE, "", cleared);
    if (cleared.domain) {
      const { domain: _d, ...hostOnly } = cleared;
      res.cookies.set(SESSION_COOKIE, "", hostOnly);
    } else if (host.endsWith("superalpha.kr")) {
      // Host-only path above; still wipe legacy shared domain cookie
      res.cookies.set(SESSION_COOKIE, "", {
        ...cleared,
        domain: ".superalpha.kr",
      });
    }
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Apex→www on all app routes; auth gate only for protected prefixes above.
     * Skip static assets / Next internals.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
