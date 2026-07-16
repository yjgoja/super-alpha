# Super Alpha (슈퍼알파)

무설치 MT5 자동매매 데모 웹앱.  
계좌번호 · 비밀번호 · 서버 3칸 입력 → **즉시 연결**.

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
| `DATABASE_URL` | Neon Postgres (서버리스는 pooled + `?pgbouncer=true`) |
| `DIRECT_URL` | (권장) Neon non-pooled — `prisma migrate deploy` 시 pooled와 충돌하면 사용; schema에는 미연결 |
| `AUTH_SECRET` | 세션 JWT (16자 이상) |
| `METAAPI_TOKEN` | MetaAPI 토큰 |
| `CRON_SECRET` | `/api/cron/tick` Bearer 전용 (GHA `bot-tick`) |
| `ADMIN_EMAILS` | 관리자 이메일 (가입 시 admin+approved) |
| `AUTO_APPROVE_USERS` | `1`이면 가입 즉시 승인 (기본: 관리자 승인 필요) |

배포 후: `npx prisma migrate deploy` (또는 Vercel build에 포함).

### 다회원 틱 (중요) — 웹 브라우저 불필요

매매(TP/DCA/SL)는 **서버 사이드** MetaAPI입니다. 사이트 탭을 닫아도 봇은 멈춘 게 아닙니다.

| 경로 | 간격 | 역할 |
|------|------|------|
| **로컬** `npm run engine` / `engine:direct` | ≈ 2초 | PC 상시 켜짐 → 최저 지연 |
| **GitHub Actions** `bot-tick.yml` | ≈ 1분 (루프) | PC 없이도 **승인된** `botEnabled` 전 회원 틱 |
| **앱 오픈 시** `BotHeartbeat` | ≈ 10초 | 해당 로그인 유저만 **보조** (대체 불가) |
| Vercel Hobby cron | ≈ 하루 1회 | 매매 엔진으로 쓰지 않음 |

**왜 웹 끄면 느려 보였나:** 예전에 GHA `schedule: * * * * *`가 공개 저장소에서 ~1시간마다만 실제 실행됐고, 브라우저 Heartbeat(10초)가 사실상 빠른 틱을 담당했습니다. 지금은 GHA 한 번이 뜨면 **~170분 동안 60초마다** `/api/cron/tick`을 호출해 브라우저 없이도 분 단위로 유지합니다.

**초 단위 TP/SL/DCA**가 필요하면 PC에서 `npm run engine:direct`를 켜 두세요 (≈2초).

스케일: 한 HTTP 틱에서 순차 처리 + ~52s 예산. 계좌가 많으면 다음 틱에서 round-robin. MetaAPI 429는 자동 재시도.

**확인:** GitHub → Actions → `Bot Tick` 초록 실행 + 로그에 `HTTP 200` / `"action":"hold"|"dca"|"tp"`. 또는 `Authorization: Bearer $CRON_SECRET`으로 `GET /api/cron/tick`.

### 가입 · 승인

- 기본: 가입 → `pending` → 관리자 승인 후 연결/봇
- `AUTO_APPROVE_USERS=1`이면 즉시 승인 (오픈 베타용)
- 거절(`rejected`) 시 API·cron·live sync 모두 차단, 봇 정지

### 커스텀 도메인 (나중에 — DNS는 여기서 설정하지 않음)

1. Vercel → Domains에 도메인 추가·DNS 확인
2. GHA `BOT_TICK_URL`을 새 도메인 `/api/cron/tick`으로 갱신
3. `AUTH_SECRET` / 쿠키는 동일 배포면 유지 (Secure 쿠키는 HTTPS 필요)
4. OAuth/외부 콜백이 있으면 허용 도메인 목록 갱신
