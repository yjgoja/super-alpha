import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Super Alpha | 무설치 자동매매",
  description:
    "계좌 세 칸만 넣으면 설치 없이 MT5 자동매매가 바로 시작됩니다. 클라우드 엔진이 초단위로 동작합니다.",
  metadataBase: new URL("https://www.superalpha.kr"),
  openGraph: {
    title: "Super Alpha",
    description: "설치 없이, 계좌 3칸으로 시작하는 자동매매.",
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
      <body className={`${display.variable} ${body.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
