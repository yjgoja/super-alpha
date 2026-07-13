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

- `DATABASE_URL` — PostgreSQL 연결 문자열
- `AUTH_SECRET` — 세션 서명 시크릿
