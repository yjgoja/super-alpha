---
name: alpha-deploy
description: 슈퍼알파 배포 (Vercel + Prisma migrate + env 체크)
model: opus
effort: high
---

# 슈퍼알파 배포 절차

프로덕션 배포는 엄격한 검증을 거칩니다.

## 배포 단계

### 1️⃣ 환경 검증
```bash
npm run verify:render-deploy
```

✅ **확인 사항:**
- DATABASE_URL 유효성
- METAAPI_TOKEN 유효성
- AUTH_SECRET 설정됨
- RENDER_API_KEY 있음
- CRON_SECRET 있음

### 2️⃣ Prisma 마이그레이션
```bash
npm run db:deploy
```

**검증:**
- ✅ 모든 마이그레이션 적용됨
- ✅ 스키마 일치
- ✅ 데이터 손실 없음
- ✅ 롤백 계획 수립

```
마이그레이션 실패 시:
- production 데이터 영향 확인
- 이전 버전으로 롤백
- 문제 원인 규명 후 재배포
```

### 3️⃣ 코드 빌드
```bash
npm run build
```

**확인:**
- ✅ 타입스크립트 오류 없음
- ✅ Next.js 빌드 성공
- ✅ 클라이언트 번들 크기 허용
- ✅ 모든 라우트 생성됨

### 4️⃣ Vercel 배포
```bash
npm run render:deploy
```

**배포 후 검증:**
- ✅ https://www.superalpha.kr 접근 가능
- ✅ 로그인 페이지 정상
- ✅ API 응답 정상
- ✅ 데이터베이스 연결 정상

### 5️⃣ 엔진 배포 (선택사항)
```
GitHub Actions 자동 트리거 또는
npm run render:status 로 상태 확인
```

## 배포 체크리스트

### 배포 전
- [ ] main 브랜치 최신화
- [ ] qa-gate 통과
- [ ] alpha-safe 확인 (실계좌 변경 시)
- [ ] 마이그레이션 검토
- [ ] 환경 변수 확인

### 배포 중
- [ ] npm run build 성공
- [ ] npm run db:deploy 성공
- [ ] Render 배포 시작
- [ ] 배포 진행 모니터링

### 배포 후
- [ ] 웹 사이트 정상 접근
- [ ] 로그인 기능 정상
- [ ] API 응답 시간 정상
- [ ] 데이터베이스 쓰기 정상
- [ ] 엔진 정상 작동

## 긴급 롤백

```bash
# 이전 버전으로 즉시 롤백
git revert HEAD
npm run render:deploy --sync-env --wait
```

**롤백 조건:**
- 🔴 데이터 손상 발생
- 🔴 로그인 불가
- 🔴 거래 기능 중단
- 🔴 실계좌 위험

## 배포 금지 조건

❌ 다음 경우 배포하지 마세요:
- qa-gate 미통과
- alpha-safe 미확인
- 마이그레이션 오류
- 데이터베이스 연결 실패
- 타입스크립트 오류
- 환경 변수 누락

## 모니터링 (배포 후)

```bash
npm run render:status      # Render 배포 상태
npm run lab:daily-report   # 일일 리포트
npm run verify:live-ui     # 라이브 UI 안전성
```

---

**배포는 신중함이 최우선입니다**
