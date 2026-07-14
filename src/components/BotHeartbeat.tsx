"use client";

import { useEffect } from "react";

/**
 * 봇 ON 동안 백그라운드 틱.
 * Vercel Hobby cron은 하루 1회라서, 앱을 열어두면 10초마다 물타기/익절을 돌린다.
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
