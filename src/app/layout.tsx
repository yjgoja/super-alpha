import type { Metadata } from "next";
import { Instrument_Serif, Manrope, Outfit, Syne } from "next/font/google";
import { ContentGuard } from "@/components/ContentGuard";
import "./globals.css";

const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
});

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
});

const landingDisplay = Syne({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-landing-display",
});

const landingBody = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-landing-body",
});

const SITE_URL = "https://www.superalpha.kr";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
    template: "%s | 슈퍼알파",
  },
  description:
    "MT5 슈퍼알파 퀀트 자동매매 프로그램. 메타트레이더5 계좌만 연결하면 EA·VPS 없이 클라우드에서 퀀트매매·퀀트트레이딩이 실행됩니다. 설치 없는 자동매매프로그램 슈퍼알파.",
  keywords: [
    "슈퍼알파",
    "MT5",
    "메타트레이더5",
    "퀀트매매",
    "자동매매",
    "퀀트트레이딩",
    "자동매매프로그램",
    "Super Alpha",
    "MetaTrader 5",
  ],
  applicationName: "슈퍼알파",
  authors: [{ name: "Super Alpha" }],
  creator: "Super Alpha",
  publisher: "Super Alpha",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
      { url: "/brand/sa-logo.png", type: "image/png", sizes: "1024x682" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: "/favicon.png",
  },
  openGraph: {
    title: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
    description:
      "메타트레이더5(MT5) 계좌만 연결하면 클라우드 퀀트 엔진이 자동매매를 실행합니다. EA 설치·VPS 없이 쓰는 슈퍼알파 자동매매프로그램.",
    url: SITE_URL,
    siteName: "슈퍼알파 Super Alpha",
    locale: "ko_KR",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Super Alpha — MT5 퀀트 자동매매",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "MT5 슈퍼알파 퀀트 자동매매 프로그램",
    description:
      "메타트레이더5 계좌 연결만으로 클라우드 퀀트매매·자동매매를 실행하는 슈퍼알파.",
    images: ["/og.png"],
  },
  verification: {
    google: "p3F75TNCfERDoQIhveouMrImyC59_1BhVYkWwxU2eYk",
    other: {
      "naver-site-verification": "abf72324b9a0e913e241b486561c952cbe37a635",
    },
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${display.variable} ${body.variable} ${landingDisplay.variable} ${landingBody.variable} antialiased`}
      >
        <ContentGuard />
        {children}
      </body>
    </html>
  );
}
