"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";

type Tilt = { x: number; y: number };

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function Scene3D({ tilt, reduced }: { tilt: Tilt; reduced: boolean }) {
  const rx = reduced ? 12 : 14 + tilt.y * 10;
  const ry = reduced ? -18 : -22 + tilt.x * 14;

  return (
    <div className="lp-stage" aria-hidden>
      <div
        className="lp-world"
        style={{
          transform: `rotateX(${rx}deg) rotateY(${ry}deg)`,
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

        <div className="lp-orbit-dot lp-orbit-1" />
        <div className="lp-orbit-dot lp-orbit-2" />
        <div className="lp-orbit-dot lp-orbit-3" />
      </div>
      <div className="lp-glow" />
    </div>
  );
}

export function LandingExperience() {
  const reduced = usePrefersReducedMotion();
  const frame = useRef<number | null>(null);
  const target = useRef<Tilt>({ x: 0, y: 0 });
  const [tilt, setTilt] = useState<Tilt>({ x: 0, y: 0 });

  useEffect(() => {
    if (reduced) return;
    const tick = () => {
      setTilt((prev) => {
        const nx = prev.x + (target.current.x - prev.x) * 0.08;
        const ny = prev.y + (target.current.y - prev.y) * 0.08;
        return { x: nx, y: ny };
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [reduced]);

  const onMove = (e: MouseEvent<HTMLElement>) => {
    if (reduced) return;
    const r = e.currentTarget.getBoundingClientRect();
    target.current = {
      x: ((e.clientX - r.left) / r.width - 0.5) * 2,
      y: ((e.clientY - r.top) / r.height - 0.5) * 2,
    };
  };

  const onLeave = () => {
    target.current = { x: 0, y: 0 };
  };

  return (
    <div className="lp-root" data-landing="css3d-crystal-a78eadd">
      <div className="lp-atmosphere" aria-hidden />

      <header className="lp-nav">
        <Link href="/" className="lp-nav-brand">
          Super Alpha
        </Link>
        <div className="lp-nav-actions">
          <Link href="/login" className="sa-btn sa-btn-ghost text-sm">
            로그인
          </Link>
          <Link href="/login?mode=register" className="sa-btn sa-btn-primary text-sm">
            시작하기
          </Link>
        </div>
      </header>

      <section className="lp-hero" onMouseMove={onMove} onMouseLeave={onLeave}>
        <Scene3D tilt={tilt} reduced={reduced} />

        <div className="lp-hero-copy">
          <p className="lp-kicker">No install · Cloud engine · MT5</p>
          <h1 className="lp-brand">Super Alpha</h1>
          <p className="lp-lead">
            계좌 세 칸만 넣으면, 설치 없이 자동매매가 바로 돌아갑니다.
          </p>
          <div className="lp-cta">
            <Link href="/login?mode=register" className="sa-btn sa-btn-primary lp-cta-main">
              무료 데모 시작
            </Link>
            <a href="#flow" className="sa-btn sa-btn-ghost">
              30초 만에 보는 흐름
            </a>
          </div>
        </div>
      </section>

      <section id="flow" className="lp-flow">
        <div className="lp-flow-inner">
          <h2 className="lp-flow-title">연결은 평면이 아니라, 한 번에 깊이로</h2>
          <p className="lp-flow-sub">
            담당자 대기 · EA 설치 · VPS 세팅 없이, 웹에서 바로 엔진이 붙습니다.
            알파지속·안정·균형·공격 로직을 고르면 끝입니다.
          </p>

          <div className="lp-steps">
            {[
              {
                n: "01",
                t: "가입",
                d: "이메일로 계정 생성",
              },
              {
                n: "02",
                t: "계좌 3칸",
                d: "Login · Password · Server",
              },
              {
                n: "03",
                t: "즉시 가동",
                d: "클라우드 엔진이 초단위로 실행",
              },
            ].map((s, i) => (
              <article
                key={s.n}
                className="lp-step"
                style={{ ["--i" as string]: String(i) }}
              >
                <div className="lp-step-face">
                  <span className="lp-step-n">{s.n}</span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </div>
                <div className="lp-step-side" />
                <div className="lp-step-bottom" />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-close">
        <div className="lp-close-panel">
          <h2 className="lp-close-title">지금, 깊이 있는 자동매매를 켜세요</h2>
          <p className="lp-close-sub">
            Super Alpha는 브라우저만으로 MT5와 연결됩니다. PC를 꺼도 클라우드는 초단위로 돕니다.
          </p>
          <Link href="/login?mode=register" className="sa-btn sa-btn-primary lp-cta-main">
            Super Alpha 시작
          </Link>
        </div>
      </section>

      <footer className="lp-foot">
        <span>© {new Date().getFullYear()} Super Alpha</span>
        <Link href="/login">로그인</Link>
      </footer>
    </div>
  );
}
