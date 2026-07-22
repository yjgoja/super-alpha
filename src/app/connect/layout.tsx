import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "계좌 연결",
  robots: { index: false, follow: false, nocache: true },
};

export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
