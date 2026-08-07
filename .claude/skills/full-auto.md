---
name: full-auto
description: 완전 자동 실행 (Plan→Execute→QA→Report). 파괴적/시크릿/실계좌만 확인
model: inherit
effort: medium
---

# 완전 자동 실행 워크플로우

4단계로 작업을 자동 완성합니다.

## 1️⃣ PLAN 단계
- 작업 분석 및 계획 수립
- 영향도 평가
- 위험 식별

## 2️⃣ EXECUTE 단계
- 승인된 플랜 자동 구현
- 파일 생성/수정
- 배포 준비

## 3️⃣ QA 단계
다음만 **사용자 확인 필요**:
- ⚠️ 파괴적 작업 (rm -rf, git reset --hard, delete)
- 🔐 시크릿/크레덴셜 노출
- 💰 실계좌 거래/비용 발생

나머지는 자동 검수:
- 린트 통과
- 테스트 통과
- 타입 체크 통과

## 4️⃣ REPORT 단계
- 완료 요약 (변경사항, 테스트 결과)
- 다음 단계 (있으면) 제시
- 확인된 위험 사항 보고

## 사용법
```
/full-auto 작업 설명
```

작업이 자동으로 plan→execute→qa→report 순서로 진행됩니다.
