---
name: alpha-engine
description: 트레이딩 엔진 운영 (Render worker, tick, cron, DCA/TP/SL)
model: opus
effort: high
disable-model-invocation: true
---

# 슈퍼알파 엔진 운영

트레이딩 엔진의 모든 측면을 관리합니다.

## 운영 대상

### 1️⃣ Render Worker
```bash
npm run engine         # 실시간 엔진
npm run engine:http    # HTTP 폴링
npm run engine:stream  # MetaAPI 스트림
npm run engine:supervise  # 감시 프로세스
```

**운영 확인 항목:**
- ✅ CPU/메모리 사용량
- ✅ 오류 로그 확인
- ✅ 응답 시간 모니터링

### 2️⃣ Tick 시스템 (주기 실행)
- **tick-direct**: 직접 호출 (localhost)
- **tick-loop**: HTTP 폴링 (MetaAPI)
- 실행 간격: ENGINE_INTERVAL_MS (기본 2000ms)

**확인 사항:**
- ✅ 시간 간격 정확성
- ✅ 데이터 유실 없음
- ✅ 데이터베이스 쓰기 성공

### 3️⃣ Cron Job (스케줄)
```
BOT_TICK_URL=https://www.superalpha.kr/api/cron/tick
```
- GitHub Actions 또는 외부 cron
- 실행 로그 기록
- 실패 시 알림

### 4️⃣ DCA (평균단가 매입)
```typescript
// 설정
FACTORY_AUTO_PROMOTE=1
FACTORY_PROMOTE_DEMO_ONLY=0
FACTORY_MAX_LOTS=0.05
FACTORY_SYMBOLS=GBPUSD,EURUSD
```

**검증:**
- ✅ 일일 한도 확인
- ✅ 자금 충분성 확인
- ✅ 포지션 겹침 방지

### 5️⃣ TP/SL (수익/손절)
```
logic-tp-sl-by-symbol.md 참조
```

**검증:**
- ✅ TP > 진입가 (수익 방향)
- ✅ SL < 진입가 (손실 한도)
- ✅ Risk/Reward 비율 (최소 1:2)

## 모니터링

```bash
npm run verify:engine-guard      # 엔진 상태 검증
npm run verify:bot-resolve       # 봇 해결 로직
npm run verify:session-h8        # 세션 상태
npm run lab:daily-report         # 일일 리포트
```

## 정상 상태 체크리스트

- [ ] Render worker 실행 중
- [ ] Tick 주기적으로 실행 (로그 확인)
- [ ] MetaAPI 연결 정상
- [ ] 포지션 진입/퇴출 정상
- [ ] TP/SL 정상 작동
- [ ] 데이터베이스 쓰기 성공
- [ ] 오류 로그 없음

## 긴급 상황

### ⚠️ 엔진 중단
```bash
# 프로세스 확인
ps aux | grep engine

# 즉시 중단
npm run engine:supervise  # 감시 모드로 재시작
```

### 🔴 실계좌 손절 필요
```
/alpha-safe force-close [포지션 ID]
```

## 배포 후 검증
1. Render 배포 완료
2. `npm run verify:engine-guard` 실행
3. 테스트 tick 한 번 수동 실행
4. 로그 확인 후 정상 작동 시작
