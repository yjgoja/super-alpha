"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Component, useEffect, useState, type ReactNode } from "react";
import { LandingFallbackScene } from "./LandingFallbackScene";

const LandingCanvas = dynamic(
  () => import("./LandingCanvas").then((m) => m.LandingCanvas),
  {
    ssr: false,
    loading: () => <LandingFallbackScene />,
  },
);

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

class CanvasErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("[LandingCanvas]", err);
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export function LandingExperience() {
  const reduced = usePrefersReducedMotion();
  // build stamp — 캐시 무효화 / 최신 랜딩 배포 확인용
  const buildStamp = "landing-latest-20260722";

  return (
    <div className="lp-root" data-landing={buildStamp}>
      <div className="lp-noise" aria-hidden />
      <div className="lp-vignette" aria-hidden />

      <header className="lp-nav">
        <Link href="/" className="lp-nav-brand">
          Super Alpha
        </Link>
        <nav className="lp-nav-actions">
          <Link href="/login" className="lp-link">
            로그인
          </Link>
          <Link href="/login?mode=register" className="lp-btn lp-btn-solid">
            시작하기
          </Link>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-stage" aria-hidden>
          {reduced ? (
            <LandingFallbackScene reduced />
          ) : (
            <CanvasErrorBoundary fallback={<LandingFallbackScene />}>
              <LandingCanvas reduced={false} />
            </CanvasErrorBoundary>
          )}
          <div className="lp-hero-fade" />
        </div>

        <div className="lp-hero-copy">
          <p className="lp-kicker">
            <span className="lp-pulse" />
            Cloud engine · Zero install
          </p>
          <h1 className="lp-brand">
            Super
            <br />
            Alpha
          </h1>
          <p className="lp-lead">
            EA 설치도, VPS도 필요 없습니다.
            <br />
            계좌 세 칸이면 자동매매가 클라우드에서 돌아갑니다.
          </p>
          <div className="lp-cta">
            <Link href="/login?mode=register" className="lp-btn lp-btn-solid lp-btn-lg">
              무료로 엔진 켜기
            </Link>
            <a href="#proof" className="lp-btn lp-btn-ghost lp-btn-lg">
              왜 다른지 보기
            </a>
          </div>
        </div>
      </section>

      <section id="proof" className="lp-proof">
        <div className="lp-proof-inner">
          <p className="lp-section-kicker">Why Super Alpha</p>
          <h2 className="lp-section-title">
            복잡한 세팅은 우리가 지고,
            <br />
            당신은 시작만 하세요
          </h2>

          <div className="lp-marquee" aria-hidden>
            <div className="lp-marquee-track">
              <div className="lp-marquee-row">
                <span>No EA install</span>
                <span>MT5 cloud sync</span>
                <span>2s tick engine</span>
                <span>DCA · TP · SL</span>
                <span>PC off = still live</span>
                <span>Login · Password · Server</span>
              </div>
              <div className="lp-marquee-row">
                <span>No EA install</span>
                <span>MT5 cloud sync</span>
                <span>2s tick engine</span>
                <span>DCA · TP · SL</span>
                <span>PC off = still live</span>
                <span>Login · Password · Server</span>
              </div>
            </div>
          </div>

          <div className="lp-bento">
            <article className="lp-tile lp-tile-wide">
              <span className="lp-tile-num">01</span>
              <h3>설치 없는 연결</h3>
              <p>
                파일을 받고 컴파일하고 차트에 붙이는 과정이 없습니다. 로그인·비번·서버만 넣으면
                MetaAPI 클라우드가 MT5에 붙습니다.
              </p>
            </article>
            <article className="lp-tile">
              <span className="lp-tile-num">02</span>
              <h3>초단위 엔진</h3>
              <p>
                익절·물타기·손절이 클라우드에서 연속 실행됩니다. PC를 꺼도 엔진은 멈추지 않습니다.
              </p>
            </article>
            <article className="lp-tile">
              <span className="lp-tile-num">03</span>
              <h3>전략은 표로</h3>
              <p>
                알파지속·안정·균형·공격 로직 중 고르면 끝. 복잡한 파라미터 지옥 없이 바로
                가동합니다.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="lp-close">
        <div className="lp-close-card">
          <h2>
            지금 계좌를 연결하면,
            <br />
            다음 틱부터 엔진이 일합니다
          </h2>
          <p>데모로 먼저, 준비가 되면 실계좌로. 같은 화면, 같은 3칸.</p>
          <Link href="/login?mode=register" className="lp-btn lp-btn-solid lp-btn-lg">
            Super Alpha 시작
          </Link>
        </div>
      </section>

      <footer className="lp-foot">
        <span>© {new Date().getFullYear()} Super Alpha</span>
        <div className="lp-foot-links">
          <Link href="/login">로그인</Link>
          <Link href="/login?mode=register">가입</Link>
        </div>
      </footer>
    </div>
  );
}
