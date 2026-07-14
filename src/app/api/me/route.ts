import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/access";
import { gateErrorKo } from "@/lib/ko-errors";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: gateErrorKo("unauthorized") }, { status: 401 });
  }
  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    approvalStatus: user.approvalStatus,
  });
}
