import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <header className="sa-shell flex items-center justify-between py-6">
        <div className="font-display text-2xl tracking-tight">Super Alpha</div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="sa-btn sa-btn-ghost text-sm">
            로그인
          </Link>
          <Link href="/login?mode=register" className="sa-btn sa-btn-primary text-sm">
            데모로 시작
          </Link>
        </div>
      </header>

      <section className="sa-shell grid min-h-[78vh] items-end gap-10 pb-16 pt-8 md:grid-cols-[1.2fr_0.8fr]">
        <div className="sa-rise">
          <p className="mb-4 text-sm uppercase tracking-[0.22em] text-[var(--muted)]">
            No install · Instant connect
          </p>
          <h1 className="font-display max-w-3xl text-5xl leading-[1.05] md:text-7xl">
            Super Alpha
          </h1>
          <p className="mt-5 max-w-xl text-lg text-[var(--muted)]">
            계좌번호 · 비밀번호 · 서버. 세 칸만 넣으면 끝.
            담당자 승인 대기 없이 바로 자동매매를 시작합니다.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login?mode=register" className="sa-btn sa-btn-primary">
              무료 데모 시작
            </Link>
            <a href="#how" className="sa-btn sa-btn-ghost">
              어떻게 다른가요
            </a>
          </div>
        </div>

        <div className="sa-rise sa-rise-delay sa-panel relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(200,245,66,0.18),transparent_45%)]" />
          <div className="relative space-y-4">
            <span className="sa-badge sa-badge-live">DEMO ENGINE</span>
            <div className="font-display text-4xl">+12.4%</div>
            <p className="text-sm text-[var(--muted)]">누적 수익률 · 익절 38 · 손절 2</p>
            <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
              <div className="rounded-2xl border border-[var(--line)] p-3">
                <div className="text-[var(--muted)]">데일리</div>
                <div className="mt-1 text-xl text-[var(--accent2)]">+0.82%</div>
              </div>
              <div className="rounded-2xl border border-[var(--line)] p-3">
                <div className="text-[var(--muted)]">연결</div>
                <div className="mt-1 text-xl">즉시 완료</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="sa-shell border-t border-[var(--line)] py-16">
        <h2 className="font-display text-3xl">경쟁사보다 한 단계 짧게</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            ["1. 가입", "이메일로 바로 계정 생성"],
            ["2. 계좌 3칸", "Login / Password / Server"],
            ["3. 즉시 가동", "관리자 대기 없이 ON"],
          ].map(([t, d]) => (
            <div key={t} className="sa-panel">
              <div className="text-[var(--accent)]">{t}</div>
              <div className="mt-2 text-[var(--muted)]">{d}</div>
            </div>
          ))}
        </div>
        <p className="mt-8 max-w-2xl text-sm text-[var(--muted)]">
          Super Meta처럼 담당자 서버 등록을 기다리지 않습니다. 데모 모드에서는
          동일 UI로 즉시 연결되며, 실계좌 연동 시에도 같은 3칸 플로우를 유지합니다.
        </p>
      </section>
    </main>
  );
}
