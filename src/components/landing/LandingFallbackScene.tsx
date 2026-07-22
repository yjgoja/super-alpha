"use client";

/** CSS 3D brand stage — WebGL 로딩/실패/저사양 폴백 (a78eadd 정본) */
export function LandingFallbackScene({ reduced = false }: { reduced?: boolean }) {
  const rx = reduced ? 12 : 14;
  const ry = reduced ? -18 : -22;

  return (
    <div className="lp-stage" aria-hidden>
      <div
        className="lp-world"
        style={{
          transform: `rotateX(${rx}deg) rotateY(${ry}deg)`,
          animationPlayState: reduced ? "paused" : "running",
        }}
      >
        <div className="lp-grid" />
        <div className="lp-ring lp-ring-a" />
        <div className="lp-ring lp-ring-b" />
        <div className="lp-ring lp-ring-c" />

        <div className="lp-crystal">
          <span className="lp-crystal-face lp-crystal-front" />
          <span className="lp-crystal-face lp-crystal-left" />
          <span className="lp-crystal-face lp-crystal-right" />
          <span className="lp-crystal-face lp-crystal-top" />
          <span className="lp-crystal-core">α</span>
        </div>

        <svg className="lp-ribbon" viewBox="0 0 640 220" fill="none">
          <defs>
            <linearGradient id="lpGold" x1="0" y1="0" x2="640" y2="0">
              <stop stopColor="#f5d78e" stopOpacity="0.15" />
              <stop offset="0.45" stopColor="#e8c36a" stopOpacity="0.95" />
              <stop offset="1" stopColor="#4fd1c5" stopOpacity="0.55" />
            </linearGradient>
            <linearGradient id="lpFill" x1="0" y1="0" x2="0" y2="220">
              <stop stopColor="#e8c36a" stopOpacity="0.22" />
              <stop offset="1" stopColor="#e8c36a" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0 150 C70 140 90 90 150 95 C210 100 230 165 300 150 C370 135 390 70 460 80 C520 88 560 130 640 110 L640 220 L0 220 Z"
            fill="url(#lpFill)"
          />
          <path
            d="M0 150 C70 140 90 90 150 95 C210 100 230 165 300 150 C370 135 390 70 460 80 C520 88 560 130 640 110"
            stroke="url(#lpGold)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <g className="lp-nodes">
            <circle cx="150" cy="95" r="5" />
            <circle cx="300" cy="150" r="5" />
            <circle cx="460" cy="80" r="5" />
          </g>
        </svg>

        <div className="lp-platform">
          <div className="lp-platform-top" />
          <div className="lp-platform-edge" />
        </div>
      </div>
    </div>
  );
}
