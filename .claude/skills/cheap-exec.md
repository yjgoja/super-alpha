---
name: cheap-exec
description: 승인된 플랜만 구현 (Sonnet + medium). 빠르고 효율적
model: sonnet
effort: medium
---

# 효율적 구현 (Cheap Exec)

**이미 검토된 플랜**을 빠르게 구현합니다.

## 동작 원리

1. `/plan-review`로 기획 검토 완료
2. `/cheap-exec`로 구현 시작
3. Sonnet 모델로 빠르게 실행
4. `/qa-gate`로 검수

## 특징

⚡ **빠름**: Sonnet 모델 사용
💰 **저비용**: Medium 사고력만 필요
✅ **신뢰성**: plan-review 검토 후 실행

## 처리 대상

### ✅ 할 수 있는 것
- 코드 작성/수정
- 파일 생성/삭제
- 테스트 작성
- 문서 작성
- 배포 준비

### ❌ 할 수 없는 것
- 기획 수정 (plan-review로)
- QA 검사 (qa-gate로)
- 아키텍처 결정 (plan-review로)

## 사용법
```
/cheap-exec 구현할 내용
```

**필수**: `/plan-review`로 먼저 검토하세요

## 비용 효율
- plan-review (Opus xhigh): 비싼 분석
- cheap-exec (Sonnet medium): 저비용 구현
- qa-gate (Opus high): 최종 검수

총 비용 최소화 + 품질 보장
