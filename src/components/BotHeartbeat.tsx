"use client";

import { useEffect } from "react";
import { publishLive } from "@/lib/live-bus";

/**
 * Single live coordinator while the app is open:
 * - SSE /api/live/stream → DB equity/PnL ~2s (feels instant) — paused when tab hidden
 * - MetaAPI ?live=1&lite=1 every ~12s (positions) + publish to all screens
 * - bot ON → soft tick POST (same assist path as before; does not replace Render engine)
 *
 * Home/Market subscribe via live-bus — no duplicate MetaAPI polls.
 * Trading decisions never use the UI snapshot cache (engine uses fresh fetchSnapshot).
 */
export function BotHeartbeat() {
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let linked = false;
    let botOn = false;
    let es: EventSource | null = null;
    let pnlPass = 0;

    function closeSse() {
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      es = null;
    }

    function openSse() {
      if (stopped || es) return;
      if (document.visibilityState === "hidden") return;
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
          closeSse();
          if (!stopped && document.visibilityState === "visible") {
            setTimeout(() => {
              if (!stopped && !es && document.visibilityState === "visible") openSse();
            }, 4000);
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
          // Lite live only — deal PnL sync is owned by engine / rare home refresh
          const liveRes = await fetch(`/api/stats?live=1&lite=1`, {
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

        // Soft assist — never await (blocks next live poll / freezes UI)
        if (botOn && pnlPass % 3 === 0) {
          void fetch("/api/stats", { method: "POST" }).catch(() => null);
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
        openSse();
        metaTick();
      } else {
        // Stop DB SSE while backgrounded — protects Postgres under many idle tabs
        closeSse();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      closeSse();
    };
  }, []);

  return null;
}
