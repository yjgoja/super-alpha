# Super Alpha (슈퍼알파)

무설치 MT5 자동매매 데모 웹앱.  
계좌번호 · 비밀번호 · 서버 3칸 입력 → **즉시 연결**.

**Production:** https://www.superalpha.kr/

## 로컬 실행

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

http://localhost:3000

## 배포

GitHub + Vercel. Production 환경변수:

| 변수 | 설명 |
|------|------|
| `DATABASE_URL` | **Always-on Postgres** (Render 등). Neon Free 서버리스 금지 — 쿼터 초과 시 실계좌 TP/SL 중단 |
| `DIRECT_URL` | (선택) migrate용 non-pooled URL |
| `AUTH_SECRET` | 세션 JWT (16자 이상) |
| `METAAPI_TOKEN` | MetaAPI 토큰 |
| `CRON_SECRET` | `/api/cron/tick` Bearer 전용 (GHA `bot-tick`) |
| `ADMIN_EMAILS` | 관리자 이메일 (가입 시 admin+approved) |
| `AUTO_APPROVE_USERS` | `1`이면 가입 즉시 승인 (기본: 관리자 승인 필요) |

배포 후: `npx prisma migrate deploy` (또는 Vercel build에 포함).

### 다회원 틱 (중요) — PC·웹 브라우저 불필요

매매(TP/DCA/SL)는 **서버 사이드** MetaAPI입니다.

| 경로 | 간격 | 역할 |
|------|------|------|
| **Render Worker** `super-alpha-engine` | ≈ 2초 | **주 엔진** — PC 꺼도 24시간 초단위 매매 |
| **로컬** `npm run engine:supervise` | ≈ 2초 | 백업/개발용 (Render와 동시 켜도 틱락으로 중복주문 방지) |
| **GitHub Actions** `bot-tick.yml` | ≈ 1분 | 워커 장애 시 분 단위 백업 |
| **앱 오픈 시** `BotHeartbeat` | ≈ 10초 | 보조만 |

**초단위 실거래:** Render Background Worker(Starter ≈ $7/월)가 `scripts/tick-direct.ts`를 상시 실행합니다. Neon Free 서버리스는 사용 금지(쿼터 시 매매 중단).

로컬 백업이 필요하면 `scripts/start-engine.ps1`을 켜 두세요. 슈퍼바이저가 크래시 시 자동 재시작·`.env` 재로드합니다.

스케일: 한 HTTP 틱에서 순차 처리 + ~52s 예산. 계좌가 많으면 다음 틱에서 round-robin. MetaAPI 429는 자동 재시도.

**확인:** GitHub → Actions → `Bot Tick` 초록 실행 + 로그에 `HTTP 200` / `"action":"hold"|"dca"|"tp"`. 또는 `Authorization: Bearer $CRON_SECRET`으로 `GET /api/cron/tick`.

### 가입 · 승인

- 기본: 가입 → `pending` → 관리자 승인 후 연결/봇
- `AUTO_APPROVE_USERS=1`이면 즉시 승인 (오픈 베타용)
- 거절(`rejected`) 시 API·cron·live sync 모두 차단, 봇 정지

### 커스텀 도메인

- 운영 도메인: `https://www.superalpha.kr/` (`superalpha.kr` → www 리다이렉트)
- GHA `BOT_TICK_URL` = `https://www.superalpha.kr/api/cron/tick`
- 세션 쿠키는 host-only(`path=/`) — www와 apex를 섞어 쓰지 말고 **www**로 접속
