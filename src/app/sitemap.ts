import type { MetadataRoute } from "next";

/** 검색엔진에는 메인 홈만 제출 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://www.superalpha.kr/",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
