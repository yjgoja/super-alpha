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

### 다회원 틱 (중요)

- **로컬** `npm run engine` / `engine:direct` ≈ 2초: 전 회원 실시간 틱
- **GitHub Actions** `.github/workflows/bot-tick.yml` ≈ 1분: PC 없이도 **승인된** 전 회원 `botEnabled` 계좌 틱
- Vercel Hobby cron은 사실상 하루 1회라 매매 엔진으로 쓰지 않음
- 앱 오픈 시 `BotHeartbeat`는 해당 유저만 보조 틱 (전체 대체 불가)

**실시간 갭:** GHA/Vercel 경로는 ~1분 간격. 초 단위 TP/SL/DCA가 필요하면 로컬·Fly·Railway 등 always-on 워커를 유지하세요. PC 없이도 1분 틱으로 다회원 운영은 가능합니다.

스케일: 한 요청에서 순차 틱 + ~52s 예산. 계좌가 많으면 다음 분에 round-robin으로 이어집니다. MetaAPI 429는 자동 재시도합니다.

### 가입 · 승인

- 기본: 가입 → `pending` → 관리자 승인 후 연결/봇
- `AUTO_APPROVE_USERS=1`이면 즉시 승인 (오픈 베타용)
- 거절(`rejected`) 시 API·cron·live sync 모두 차단, 봇 정지

### 커스텀 도메인 (나중에 — DNS는 여기서 설정하지 않음)

1. Vercel → Domains에 도메인 추가·DNS 확인
2. GHA `BOT_TICK_URL`을 새 도메인 `/api/cron/tick`으로 갱신
3. `AUTH_SECRET` / 쿠키는 동일 배포면 유지 (Secure 쿠키는 HTTPS 필요)
4. OAuth/외부 콜백이 있으면 허용 도메인 목록 갱신
