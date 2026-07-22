import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "대시보드",
  robots: { index: false, follow: false, nocache: true },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
