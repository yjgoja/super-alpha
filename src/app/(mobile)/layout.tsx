import { BottomNav } from "@/components/BottomNav";
import { BotHeartbeat } from "@/components/BotHeartbeat";

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
