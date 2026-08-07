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

## 🔍 모니터링

### 배포 후 검증
```bash
npm run render:status          # 배포 상태
npm run verify:engine-guard    # 엔진 상태
npm run lab:daily-report       # 일일 리포트
```

### 긴급 상황
```bash
# 엔진 즉시 중단
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
