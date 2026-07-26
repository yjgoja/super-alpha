"use client";

import { useEffect, useId, useRef } from "react";

/** Map our MT5 symbols to TradingView symbols (reference feed, not Zero Markets). */
export function toTradingViewSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  switch (s) {
    case "XAUUSD":
      return "OANDA:XAUUSD";
    case "EURUSD":
      return "FX:EURUSD";
    case "GBPUSD":
      return "FX:GBPUSD";
    case "AUDUSD":
      return "FX:AUDUSD";
    default:
      return `FX:${s}`;
  }
}

type Props = {
  symbol: string;
  height?: number;
  interval?: string;
};

/**
 * TradingView advanced chart embed — remounts when symbol changes.
 * Visual reference only; not the Zero Markets / MetaAPI execution feed.
 */
export function TradingViewSymbolChart({
  symbol,
  height = 320,
  interval = "5",
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const tvSymbol = toTradingViewSymbol(symbol);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !symbol) return;

    host.innerHTML = "";
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = `${height}px`;
    container.style.width = "100%";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    container.appendChild(widget);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.text = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval,
      timezone: "Asia/Seoul",
      theme: "dark",
      style: "1",
      locale: "kr",
      allow_symbol_change: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      backgroundColor: "rgba(12, 14, 18, 1)",
      gridColor: "rgba(255, 255, 255, 0.06)",
      withdateranges: true,
      range: "1D",
    });
    container.appendChild(script);
    host.appendChild(container);

    return () => {
      host.innerHTML = "";
    };
  }, [symbol, tvSymbol, height, interval, reactId]);

  return (
    <div
      ref={hostRef}
      className="sa-tv-chart"
      style={{
        width: "100%",
        height,
        borderRadius: 12,
        overflow: "hidden",
        background: "rgba(0,0,0,0.25)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
      aria-label={`${symbol} 실시간 차트`}
    />
  );
}
