import type { MetadataRoute } from "next";

/**
 * 로그인 전 공개 페이지(홈)만 검색엔진에 노출.
 * 어드민·거래/봇 UI·API는 전부 차단.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/admin",
          "/admin/",
          "/bot",
          "/bot/",
          "/home",
          "/home/",
          "/manage",
          "/manage/",
          "/market",
          "/market/",
          "/mypage",
          "/mypage/",
          "/pnl",
          "/pnl/",
          "/login",
          "/login/",
          "/connect",
          "/connect/",
          "/dashboard",
          "/dashboard/",
          "/pending",
          "/pending/",
          "/verify-email",
          "/verify-email/",
          "/api/",
        ],
      },
    ],
    sitemap: "https://www.superalpha.kr/sitemap.xml",
    host: "https://www.superalpha.kr",
  };
}
