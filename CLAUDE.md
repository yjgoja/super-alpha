# 슈퍼알파 자동화 가이드

## 📋 워크플로우

모든 작업은 이 순서를 따릅니다:

### 일반 작업
```
/plan-review 대형 작업
  ↓
/cheap-exec 구현
  ↓
/qa-gate 검수
  ↓
git commit (자동) → git push (자동) → 배포 완료
```

### 실계좌/배포 작업
```
/plan-review 계획
  ↓
/alpha-safe 안전 확인 (필수! 사람이 확인)
  ↓
/cheap-exec 구현
  ↓
/qa-gate 검수
  ↓
/alpha-deploy 배포 또는 /alpha-engine 엔진
  ↓
배포 완료
```

---

## 🎯 스킬 사용법

| 스킬 | 목적 | 모델 | 언제 |
|------|------|------|------|
| `/plan-review` | 상세 기획 검토 | Opus xhigh | 대형/복잡한 작업 전 |
| `/cheap-exec` | 효율적 구현 | Sonnet medium | plan-review 후 |
| `/qa-gate` | 배포 전 검수 | Opus high | 병합/배포 전 |
| `/alpha-safe` | 실계좌 안전 | Opus high | 거래/배포 직전 |
| `/alpha-engine` | 엔진 운영 | Opus high | 엔진 관련 작업 |
| `/alpha-deploy` | 프로덕션 배포 | Opus high | 배포 시 |
| `/cost-router` | 모델 자동 선택 | inherit | (자동 사용) |
| `/full-auto` | 자동 완성 | inherit | 자동화 가능한 작업 |

---

## ⚡ 자동화 규칙

### ✅ 자동 허용 (사용자 확인 없음)
- 코드 작성/수정
- 테스트 작성
- 문서 작성
- 배포 준비

### 🔴 항상 확인 (사용자 승인 필수)
- 파괴적 작업 (rm -rf, git reset --hard)
- 시크릿/크레덴셜 노출
- **실계좌 거래** (MetaAPI, force-close)
- **배포** (Vercel, Render)

### 🔐 자동 검사
```
코드 수정 → 자동 TypeScript 검사
  ├─ 오류 있음 → 중단 (수정 필요)
  └─ 오류 없음 → 계속
```

---

## 💰 비용 최적화

### Opus 사용 (비싼 분석)
- 기획 (plan-review)
- 리스크 평가
- 최종 검수 (qa-gate)

### Sonnet 사용 (저비용 구현)
- 승인된 계획 구현 (cheap-exec)
- 버그 수정
- 간단한 기능

**결과**: 월 비용 30-50% 절감 + 품질 보장

---

## 📦 배포 시스템

### 자동 배포
```bash
git push origin master
  → GitHub Actions 트리거
  → lint/test 자동 실행
  → Render 엔진 배포 (자동)
  → 완료 알림
```

### 수동 배포
```bash
/alpha-deploy Vercel + Prisma 배포
```

---

## 🛡️ 안전 규칙

### Fail-Closed (기본값: 금지)
- 불명확하면 중단
- 승인 필수 항목:
  - 실계좌 거래
  - 강제 종료 (force-close)
  - 프로덕션 배포

### 권한 체계
- `defaultMode: "auto"` 자동 승인 가능
- 위험 작업은 `user-invocable-only` (직접 /로만)

---

## 🏗️ 실행 위치 (2026-08-07 정리)

| 무엇 | 어디서 | 자동시작 | 비고 |
|---|---|---|---|
| **거래 엔진** | Render `super-alpha-engine` | GH Actions (master push) | **PC에서 돌리지 말 것** |
| **로직공장** | 내 PC `scripts/start-factory.ps1` | 시작프로그램 `LogicFactoryInvent.lnk` | dry-promote(발굴만) |
| 공장 스모크테스트 | GH Actions 6시간마다 | cron | 저장·승격 안 함 |

### ⛔ 로컬 엔진을 켜지 말 것
`scripts/start-engine.ps1`은 남겨뒀지만 시작프로그램에서 **비활성화**했다
(`SuperAlphaEngine.lnk.disabled`). Render 엔진과 같은 DB를 쓰기 때문에 동시에 켜면
같은 계좌를 두 엔진이 틱한다. 교차 인스턴스 뮤텍스는 `BrokerAccount.tickLockedAt`이며
`meta-engine.tryAcquireTickLock`이 관리한다 — 이걸 무조건 초기화하는 코드를 절대 넣지 말 것.

### 공장 승격을 실계좌에 반영하려면
기본은 `--dry-promote`(발굴만). 자동 승격을 켜려면 `FACTORY_ALLOW_PROMOTE=1`.
켜기 전에 사람이 후보를 확인할 것.

## 🔍 모니터링

### 배포 후 검증
```bash
npm run render:status          # 배포 상태 (RENDER_API_KEY 필요)
npm run engine:verify-guard    # 엔진 가드 검증
```

### 엔진 살아있는지 확인 (가장 빠름)
`scripts/out/engine-heartbeat.json` 의 **파일 수정시각**을 본다.
`ok: true` 는 죽어도 그대로 남으므로 신뢰하지 말 것. 갱신이 멈췄으면 죽은 것이다.

### 긴급 상황
```bash
# 엔진 supervisor 시작 (중단 아님 — 중단은 프로세스를 kill 해야 함)
npm run engine:supervise

# 실계좌 손절
/alpha-safe force-close [포지션]

# 배포 롤백
git revert HEAD && /alpha-deploy
```

---

## 📚 참고

### 전역 (모든 프로젝트 공통)
- `~/.claude/CLAUDE.md` - **모델 라우팅 규칙 + 안전 규칙** (실제 동작하는 지시)
- `~/.claude/skills/<이름>/SKILL.md` - plan-review, cheap-exec, qa-gate, cost-router, full-auto
- `~/.claude/hooks/tsc-check.mjs` - TS 자동 타입 검사 훅
- `~/.claude/settings.json` - 권한 + 훅 등록

### 이 프로젝트 전용
- `.claude/skills/<이름>/SKILL.md` - alpha-safe, alpha-engine, alpha-deploy
  (이 repo의 npm 스크립트·MetaAPI·Render에 의존하므로 전역에 두지 않음)
- `.claude/settings.json` - 권한만 (훅은 전역에서 처리)
- `AGENTS.md` - 에이전트 정의 (Next.js 특수사항)

> 스킬 파일은 반드시 `<이름>/SKILL.md` 폴더 구조여야 인식된다.
> 평평한 `<이름>.md`는 스캔되지 않는다.

---

@AGENTS.md
