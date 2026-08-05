import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/access";
import { ensureTradingSchema, prisma } from "@/lib/db";
import { gateErrorKo } from "@/lib/ko-errors";

export const runtime = "nodejs";

/**
 * Phone command-center catalog for all projects.
 * Local PC automations (blog/factory) are driven via Cursor private worker;
 * this API exposes status hints + copy-ready instruct phrases.
 */
export async function GET() {
  await ensureTradingSchema();
  const gate = await requireAdmin();
  if (!gate.user) {
    return NextResponse.json({ error: gateErrorKo(gate.error) }, { status: gate.status });
  }

  const [botsOn, openBaskets, pendingUsers, pendingAccounts] = await Promise.all([
    prisma.brokerAccount.count({ where: { botEnabled: true } }),
    prisma.basket.count({ where: { status: "open" } }),
    prisma.user.count({ where: { approvalStatus: "pending", role: { not: "admin" } } }),
    prisma.brokerAccount.count({
      where: { status: { in: ["pending_registration", "provisioning", "failed"] } },
    }),
  ]);

  const projects = [
    {
      id: "trading",
      name: "슈퍼알파 트레이딩",
      kind: "app",
      summary: `봇 ON ${botsOn} · 열린 바스켓 ${openBaskets} · 승인대기 회원 ${pendingUsers} / 계좌 ${pendingAccounts}`,
      hrefs: [
        { label: "봇", href: "/bot" },
        { label: "전략 상세", href: "/manage/strategy" },
        { label: "관리자", href: "/admin" },
        { label: "계좌", href: "/manage" },
      ],
      cursorPrompts: [
        "활성 계좌 봇 전체 중지해줘",
        "원격 계좌 골라서 XAU 로트 0.02로 바꿔줘",
        "전략 회차 TP/SL 수정해줘",
      ],
    },
    {
      id: "naver-blog-seo",
      name: "네이버 블로그·이미지 자동화",
      kind: "local",
      summary:
        "키워드 SEO 글 + 썸네일/본문 이미지. 폰에서는 Cursor에 지시 → PC private worker 실행.",
      hrefs: [],
      cursorPrompts: [
        "naver-blog-seo 상태 확인해줘 (python scripts/remote_ctl.py status)",
        "블로그 dry-run 1건 돌려줘",
        "블로그 once 1건 작성해줘 (자동발행 말고 검수용)",
        "블로그 스케줄 자동화 시작해줘",
        "블로그 자동화 멈춰줘",
      ],
      commands: [
        "cd naver-blog-seo && python scripts/remote_ctl.py status",
        "cd naver-blog-seo && python scripts/remote_ctl.py dry-run --count 1",
        "cd naver-blog-seo && python scripts/remote_ctl.py once --count 1",
        "cd naver-blog-seo && python scripts/remote_ctl.py schedule",
        "cd naver-blog-seo && python scripts/remote_ctl.py stop",
      ],
    },
    {
      id: "logic-factory",
      name: "로직 팩토리 (invent24)",
      kind: "local",
      summary: "신규 로직 탐색 24/7. start-factory-invent.ps1 / supervise-factory.",
      hrefs: [{ label: "팩토리 API", href: "/api/factory/status" }],
      cursorPrompts: [
        "invent24 팩토리 상태 확인해줘",
        "팩토리 invent 재시작해줘 (scripts/start-factory-invent.ps1)",
        "텔레그램 일일보고 설정 확인해줘",
      ],
      commands: [
        "powershell -ExecutionPolicy Bypass -File scripts/start-factory-invent.ps1",
        "npm run lab:factory:invent",
      ],
    },
    {
      id: "engine",
      name: "엔진 / MetaAPI",
      kind: "server",
      summary: "Render 엔진·보호·DCA. 코드 수정은 Cursor 폰에서 지시.",
      hrefs: [{ label: "관리자 비용", href: "/admin" }],
      cursorPrompts: [
        "엔진 보호/슬립 로직 확인해줘",
        "Render 배포 상태 확인해줘",
        "라이브 바스켓 naked TP/SL 없는지 검증해줘",
      ],
    },
  ];

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    note: "로컬 자동화(블로그·팩토리)는 Cursor 폰 → private worker PC에서 실행합니다.",
    projects,
  });
}
