"use client";

import { useEffect } from "react";
import { publishLive } from "@/lib/live-bus";

/**
 * Single live coordinator while the app is open:
 * - SSE /api/live/stream → DB equity/PnL ~1.5s (feels instant)
 * - MetaAPI ?live=1&lite=1 every ~12s (positions) + publish to all screens
 * - bot ON → soft tick POST
 *
 * Home/Market subscribe via live-bus — no duplicate MetaAPI polls.
 */
export function BotHeartbeat() {
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let linked = false;
    let botOn = false;
    let es: EventSource | null = null;
    let pnlPass = 0;

    function openSse() {
      if (stopped || es) return;
      try {
        es = new EventSource("/api/live/stream");
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as {
              type?: string;
              account?: Record<string, unknown> | null;
            };
            if (data.type === "live") {
              publishLive({ source: "sse", account: data.account ?? null });
              if (data.account?.metaApiAccountId) linked = true;
              if (typeof data.account?.botEnabled === "boolean") {
                botOn = data.account.botEnabled;
              }
            }
          } catch {
            /* ignore bad frames */
          }
        };
        es.onerror = () => {
          // Browser will retry; if permanently dead, meta poll still works
          try {
            es?.close();
          } catch {
            /* ignore */
          }
          es = null;
          if (!stopped) {
            setTimeout(() => {
              if (!stopped && !es) openSse();
            }, 3000);
          }
        };
      } catch {
        es = null;
      }
    }

    async function metaTick() {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        // First pass: cheap DB link check if SSE has not established yet
        if (!linked) {
          const res = await fetch("/api/stats?summary=1", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          linked = Boolean(data.account?.metaApiAccountId);
          botOn = Boolean(data.account?.botEnabled);
          if (data.account) {
            publishLive({ source: "db", account: data.account });
          }
        }

        if (linked) {
          pnlPass += 1;
          // Every ~5th meta tick (~60s) refresh today's PnL from deals
          const pnlQ = pnlPass % 5 === 0 ? "&pnl=1" : "";
          const liveRes = await fetch(`/api/stats?live=1&lite=1${pnlQ}`, {
            cache: "no-store",
          });
          if (liveRes.ok) {
            const live = await liveRes.json();
            if (live.account) {
              publishLive({ source: "meta", account: live.account });
              botOn = Boolean(live.account.botEnabled);
            }
          }
        }

        if (botOn) {
          await fetch("/api/stats", { method: "POST" });
        }
      } catch {
        /* ignore */
      } finally {
        busy = false;
      }
    }

    openSse();
    metaTick();
    const id = setInterval(metaTick, 12_000);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (!es) openSse();
        metaTick();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      es = null;
    };
  }, []);

  return null;
}
