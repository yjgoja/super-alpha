"use client";

import { useEffect } from "react";

/**
 * Soft anti-exfil for strategy IP: block context menu / copy / drag on app surfaces.
 * Not absolute security — pairs with API redaction. Inputs remain selectable.
 */
export function ContentGuard() {
  useEffect(() => {
    const block = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (
        t.closest(
          "input, textarea, select, [contenteditable='true'], [data-allow-copy='true']",
        )
      ) {
        return;
      }
      e.preventDefault();
    };

    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (["c", "x", "s", "u", "p"].includes(key)) {
        const t = e.target as HTMLElement | null;
        if (
          t?.closest(
            "input, textarea, select, [contenteditable='true'], [data-allow-copy='true']",
          )
        ) {
          return;
        }
        e.preventDefault();
      }
      // Ctrl+Shift+I / J — soft deter only
      if (e.shiftKey && (key === "i" || key === "j" || key === "c")) {
        e.preventDefault();
      }
    };

    document.addEventListener("contextmenu", block);
    document.addEventListener("copy", block);
    document.addEventListener("cut", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("copy", block);
      document.removeEventListener("cut", block);
      document.removeEventListener("dragstart", block);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
