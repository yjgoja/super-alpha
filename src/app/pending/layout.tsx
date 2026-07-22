import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "승인 대기",
  robots: { index: false, follow: false, nocache: true },
};

export default function PendingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
