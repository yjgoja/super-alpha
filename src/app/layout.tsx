import type { Metadata } from "next";
import { Instrument_Serif, Manrope, Outfit, Syne } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Super Alpha | 무설치 자동매매",
  description:
    "EA 설치 없이 계좌 세 칸만 연결하세요. 클라우드 엔진이 초단위로 익절·물타기·손절을 실행합니다.",
  metadataBase: new URL("https://www.superalpha.kr"),
  openGraph: {
    title: "Super Alpha — 설치 없는 자동매매",
    description: "EA·VPS 없이, 계좌만 연결하면 클라우드 엔진이 바로 돌아갑니다.",
    url: "https://www.superalpha.kr",
    siteName: "Super Alpha",
    locale: "ko_KR",
    type: "website",
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
        {children}
      </body>
    </html>
  );
}
