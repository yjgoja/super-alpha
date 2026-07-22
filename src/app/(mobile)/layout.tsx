import type { Metadata } from "next";
import { BottomNav } from "@/components/BottomNav";
import { BotHeartbeat } from "@/components/BotHeartbeat";

/** 로그인 후 앱 화면 — 검색 비노출 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function MobileAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="m-app">
      <BotHeartbeat />
      <main className="m-main">{children}</main>
      <BottomNav />
    </div>
  );
}
