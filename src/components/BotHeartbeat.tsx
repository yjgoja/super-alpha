"use client";

import { useEffect } from "react";

/**
 * While the app is open and bot is ON, soft-sync equity and run a user-scoped tick.
 * Optional supplement only — GHA bot-tick loop (~1/min) and local engine (~2s) own trading.
 * Closing the browser must NOT stop TP/DCA; those paths are server-side.
 * Does NOT rebuild baskets (that used to desync DCA levels).
 */
export function BotHeartbeat() {
  useEffect(() => {
    let stopped = false;

    async function tick() {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) return;
        const data = await res.json();
        if (data.account?.botEnabled) {
          await fetch("/api/stats", { method: "POST" });
        }
      } catch {
        /* ignore */
      }
    }

    tick();
    const id = setInterval(tick, 10_000);
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
