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

- `DATABASE_URL` — Neon Postgres (서버리스는 pooled URL + `?pgbouncer=true` 권장)
- `AUTH_SECRET` — 세션 JWT 시크릿 (16자 이상, 프로덕션 필수)
- `METAAPI_TOKEN` — MetaAPI 토큰
- `CRON_SECRET` — `/api/cron/tick` + GitHub Actions `bot-tick` 보호용 Bearer 시크릿
- `ADMIN_EMAILS` — (선택) 관리자 이메일 목록

### 다회원 틱 (중요)

- **로컬** `npm run engine` / `engine:direct` ≈ 2초: 전 회원 실시간 틱
- **GitHub Actions** `.github/workflows/bot-tick.yml` ≈ 1분: PC 없이도 **전체** `botEnabled` 계좌 틱
- Vercel Hobby cron은 사실상 하루 1회라 매매 엔진으로 쓰지 않음
- 앱 오픈 시 `BotHeartbeat`는 해당 유저만 보조 틱 (전체 대체 불가)

실시간(초 단위)이 필요하면 로컬/Fly/Railway 등 always-on 워커를 유지하세요.

### 커스텀 도메인 (나중에)

1. Vercel → Domains에 도메인 추가·DNS 확인
2. `BOT_TICK_URL` (GHA vars)를 새 도메인 `/api/cron/tick`으로 갱신
3. `AUTH_SECRET` / 쿠키는 동일 배포면 유지 (Secure 쿠키는 HTTPS 필요)