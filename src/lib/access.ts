import { cookies } from "next/headers";
import { prisma } from "./db";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "master")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** When true, new registrations are approved immediately (default: admin gate). */
export function autoApproveUsers(): boolean {
  return process.env.AUTO_APPROVE_USERS === "1" || process.env.AUTO_APPROVE_USERS === "true";
}

export function isAdminEmail(email: string) {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const userId = await verifySessionToken(token);
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) return { error: "unauthorized" as const, status: 401 as const, user: null };
  return { error: null, status: 200 as const, user };
}

export async function requireApprovedUser() {
  const res = await requireUser();
  if (!res.user) return res;
  if (res.user.role === "admin") return { error: null, status: 200 as const, user: res.user };
  if (res.user.approvalStatus === "rejected") {
    return { error: "rejected" as const, status: 403 as const, user: null };
  }
  if (res.user.approvalStatus !== "approved") {
    return { error: "pending_approval" as const, status: 403 as const, user: null };
  }
  return { error: null, status: 200 as const, user: res.user };
}

export async function requireAdmin() {
  const res = await requireUser();
  if (!res.user) return res;
  if (res.user.role !== "admin") {
    return { error: "forbidden" as const, status: 403 as const, user: res.user };
  }
  return { error: null, status: 200 as const, user: res.user };
}
