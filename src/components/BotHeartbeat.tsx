"use client";

import { useEffect } from "react";

/**
 * While the app is open:
 * - linked account → live equity/position sync (?live=1)
 * - bot ON → soft tick POST
 */
export function BotHeartbeat() {
  useEffect(() => {
    let stopped = false;
    let busy = false;

    async function tick() {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data.account?.metaApiAccountId) {
          await fetch("/api/stats?live=1", { cache: "no-store" });
        }
        if (data.account?.botEnabled) {
          await fetch("/api/stats", { method: "POST" });
        }
      } catch {
        /* ignore */
      } finally {
        busy = false;
      }
    }

    tick();
    const id = setInterval(tick, 12_000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return null;
}
