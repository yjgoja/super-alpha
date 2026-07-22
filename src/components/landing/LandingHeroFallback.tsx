"use client";

/**
 * CSS fallback when WebGL is slow/unavailable — A2B-style stacked asset bars.
 */
export function LandingHeroFallback() {
  return (
    <div className="lp-fallback" aria-hidden>
      <div className="lp-fallback-glow" />
      <div className="lp-fallback-stack">
        <div className="lp-fallback-bar" data-label="XAU" />
        <div className="lp-fallback-bar" data-label="EUR" />
        <div className="lp-fallback-bar" data-label="MT5" />
        <div className="lp-fallback-orb" />
      </div>
    </div>
  );
}
