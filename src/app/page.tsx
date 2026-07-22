import type { Metadata } from "next";
import { LandingExperience } from "@/components/landing/LandingExperience";
import "./landing.css";

export const metadata: Metadata = {
  title: {
    absolute: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
  },
  description:
    "MT5 슈퍼알파 퀀트 자동매매 프로그램. 메타트레이더5 계좌만 연결하면 EA·VPS 없이 클라우드에서 퀀트매매·퀀트트레이딩이 실행됩니다. 설치 없는 자동매매프로그램.",
  alternates: {
    canonical: "https://www.superalpha.kr/",
  },
  openGraph: {
    title: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
    description:
      "메타트레이더5(MT5) 계좌만 연결하면 클라우드 퀀트 엔진이 자동매매를 실행합니다.",
    url: "https://www.superalpha.kr/",
    images: [
      {
        url: "https://www.superalpha.kr/og.png",
        width: 1200,
        height: 630,
        alt: "Super Alpha",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["https://www.superalpha.kr/og.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://www.superalpha.kr/#website",
      url: "https://www.superalpha.kr/",
      name: "슈퍼알파 Super Alpha",
      description:
        "MT5 슈퍼알파 퀀트 자동매매 프로그램 — 메타트레이더5 클라우드 퀀트매매",
      inLanguage: "ko-KR",
      publisher: { "@id": "https://www.superalpha.kr/#org" },
    },
    {
      "@type": "Organization",
      "@id": "https://www.superalpha.kr/#org",
      name: "슈퍼알파",
      alternateName: ["Super Alpha", "슈퍼알파 자동매매"],
      url: "https://www.superalpha.kr/",
    },
    {
      "@type": "SoftwareApplication",
      name: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
      alternateName: ["슈퍼알파", "Super Alpha"],
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description:
        "메타트레이더5(MT5) 계좌를 연결해 클라우드에서 퀀트매매·퀀트트레이딩·자동매매를 실행하는 자동매매프로그램.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "KRW",
      },
      url: "https://www.superalpha.kr/",
    },
  ],
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingExperience />
    </>
  );
}
