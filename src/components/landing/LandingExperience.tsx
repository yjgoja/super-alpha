"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LandingHeroFallback } from "./LandingHeroFallback";

const LandingCanvas = dynamic(
  () => import("./LandingCanvas").then((m) => m.LandingCanvas),
  { ssr: false, loading: () => null },
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

export function LandingExperience() {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="lp-root">
      <div className="lp-noise" aria-hidden />

      <header className="lp-nav">
        <Link href="/" className="lp-nav-brand">
          Super<span>Alpha</span>
        </Link>
        <nav className="lp-nav-links" aria-label="주요 메뉴">
          <a href="#engine">엔진</a>
          <a href="#flow">연결</a>
          <a href="#start">시작</a>
        </nav>
        <nav className="lp-nav-actions">
          <Link href="/login" className="lp-btn lp-btn-muted">
            로그인
          </Link>
          <Link href="/login?mode=register" className="lp-btn lp-btn-white">
            회원가입
          </Link>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <h1 className="lp-brand">
            Super
            <br />
            Alpha
          </h1>
          <p className="lp-headline">MT5 클라우드 퀀트 자동매매</p>
          <p className="lp-lead">
            메타트레이더5 계좌만 연결하면, 슈퍼알파 퀀트매매·퀀트트레이딩 엔진이
            EA·VPS 없이 초단위로 돌아갑니다.
          </p>
          <div className="lp-cta">
            <Link href="/login?mode=register" className="lp-btn lp-btn-white lp-btn-lg">
              무료로 시작하기
            </Link>
          </div>
        </div>

        <div className="lp-hero-stage" aria-hidden>
          <LandingHeroFallback />
          {!reduced ? <LandingCanvas reduced={false} /> : null}
        </div>
      </section>

      <section id="engine" className="lp-section">
        <div className="lp-section-inner">
          <p className="lp-section-kicker">슈퍼알파 · MT5</p>
          <h2 className="lp-section-title">
            PC를 꺼도
            <br />
            엔진은 멈주지 않습니다
          </h2>
          <p className="lp-section-lead">
            메타트레이더5 자동매매프로그램을 클라우드에서 실행합니다. 설치·차트
            붙이기·서버 관리 없이, 퀀트 프리셋만 고르면 됩니다.
          </p>

          <ul className="lp-rows">
            <li>
              <strong>Zero install</strong>
              <span>로그인·비번·서버 세 칸만 입력하면 MT5에 연결됩니다.</span>
            </li>
            <li>
              <strong>Live tick</strong>
              <span>클라우드 워커가 초단위로 포지션을 감시·실행합니다.</span>
            </li>
            <li>
              <strong>Preset only</strong>
              <span>복잡한 파라미터 대신, 검증된 퀀트 프리셋으로 가동합니다.</span>
            </li>
          </ul>
        </div>
      </section>

      <section id="flow" className="lp-section lp-section-alt">
        <div className="lp-section-inner lp-flow">
          <div>
            <p className="lp-section-kicker">How it works</p>
            <h2 className="lp-section-title">
              연결하면
              <br />
              다음 틱부터
            </h2>
          </div>
          <ol className="lp-steps">
            <li>
              <em>01</em>
              <div>
                <strong>계좌 연결</strong>
                <p>브로커 MT5 정보를 안전하게 등록</p>
              </div>
            </li>
            <li>
              <em>02</em>
              <div>
                <strong>프리셋 선택</strong>
                <p>종목·방향·시작 로트만 설정</p>
              </div>
            </li>
            <li>
              <em>03</em>
              <div>
                <strong>엔진 가동</strong>
                <p>클라우드가 24시간 자동매매</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section id="start" className="lp-close">
        <div className="lp-close-inner">
          <h2>
            Trade with the engine.
            <br />
            Not the chart.
          </h2>
          <p>데모로 먼저, 준비가 되면 실계좌로. 같은 화면, 같은 연결.</p>
          <Link href="/login?mode=register" className="lp-btn lp-btn-white lp-btn-lg">
            Super Alpha 시작
          </Link>
        </div>
      </section>

      <footer className="lp-foot">
        <span>© {new Date().getFullYear()} Super Alpha</span>
        <div className="lp-foot-links">
          <Link href="/login">로그인</Link>
          <Link href="/login?mode=register">회원가입</Link>
        </div>
      </footer>
    </div>
  );
}
