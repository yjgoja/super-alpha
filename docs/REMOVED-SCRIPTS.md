# 제거된 npm 스크립트 (2026-08-07)

참조 파일이 존재하지 않아 실행 즉시 실패하던 스크립트 27개를 package.json에서 제거했다.
대부분 `scripts/lab/` 하위인데, 이 디렉토리는 git에 한 번도 커밋된 적이 없어(`git ls-files` 0건)
디스크에서 사라진 뒤 복구 경로가 없다. 재작성이 필요하면 아래 정의를 출발점으로 쓴다.

| 스크립트 | 원래 정의 |
|---|---|
| `ticks:record` | `tsx --env-file=.env scripts/record-live-ticks.ts` |
| `ticks:g1` | `tsx --env-file=.env scripts/reprovision-g1-ticks.ts` |
| `ticks:import` | `tsx scripts/import-mt5-ticks.ts` |
| `ticks:backtest` | `tsx scripts/_backtest-ticks.ts` |
| `verify:factory` | `tsx scripts/lab/_verify-factory.ts` |
| `verify:tick-lab` | `tsx scripts/lab/_verify-tick-lab.ts` |
| `verify:trade-log` | `tsx --env-file=.env scripts/lab/_verify-trade-log.ts` |
| `verify:ladder` | `tsx scripts/lab/_verify-ladder.ts` |
| `verify:ladder-rebuild` | `tsx scripts/lab/_verify-ladder-rebuild.ts` |
| `verify:sessions` | `tsx scripts/lab/_verify-sessions.ts` |
| `verify:regimes` | `tsx scripts/lab/_verify-regimes.ts` |
| `verify:costs` | `tsx scripts/lab/_verify-costs.ts` |
| `lab:factory` | `tsx --env-file=.env scripts/lab/run-factory.ts` |
| `lab:factory:smoke` | `tsx --env-file=.env scripts/lab/run-factory.ts --smoke --symbol GBPUSD --out smoke --force-daily` |
| `lab:factory:24-7` | `tsx --env-file=.env scripts/lab/supervise-factory.ts -- --out live24 --send` |
| `lab:factory:invent` | `tsx --env-file=.env scripts/lab/supervise-factory.ts -- --out invent24 --config scripts/lab/factory-config.invent.json --workers 14 --send` |
| `verify:driver` | `tsx --env-file=.env scripts/lab/_verify-driver.ts` |
| `verify:invent-families` | `tsx --env-file=.env scripts/lab/_verify-invent-families.ts` |
| `verify:telegram-report` | `tsx scripts/lab/_verify-telegram-report.ts` |
| `verify:monthly` | `tsx scripts/lab/_verify-monthly.ts` |
| `verify:rank` | `tsx scripts/lab/_verify-rank.ts` |
| `verify:daily-report` | `tsx scripts/lab/_verify-daily-report.ts` |
| `lab:daily-report` | `tsx --env-file=.env scripts/lab/daily-report.ts` |
| `verify:signals` | `tsx scripts/lab/_verify-signals.ts` |
| `verify:genetic` | `tsx scripts/lab/_verify-genetic.ts` |
| `verify:search-space` | `tsx scripts/lab/_verify-search-space.ts` |
| `bench:search-space` | `tsx scripts/lab/_bench-search-space.ts` |
