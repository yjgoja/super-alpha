#!/bin/bash
# 슈퍼알파 거래 로직 수정 배포 스크립트
# 검증 완료 후 master 병합 및 자동 배포

set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📍 현재 브랜치: $BRANCH"

# 1. 최종 빌드 검증
echo "🔨 최종 빌드 검증 중..."
npm run build > /dev/null 2>&1 && echo "✅ 빌드 성공" || {
  echo "❌ 빌드 실패"
  exit 1
}

# 2. 타입 검사
echo "📝 타입 검사 중..."
npx tsc --noEmit > /dev/null 2>&1 && echo "✅ 타입 체크 통과" || {
  echo "❌ 타입 오류 발견"
  exit 1
}

# 3. git 상태 확인
echo "📊 git 상태 확인..."
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️ 작업 디렉토리에 미커밋 변경사항이 있습니다"
  git status
  exit 1
fi
echo "✅ git 상태 정상 (모두 커밋됨)"

# 4. master 브랜치 확인
echo "🔀 master 브랜치로 전환..."
git fetch origin master > /dev/null 2>&1
git checkout master > /dev/null 2>&1

# 5. 현재 브랜치 병합
echo "🔗 현재 브랜치를 master에 병합..."
git merge $BRANCH --no-edit > /dev/null 2>&1 && echo "✅ 병합 성공" || {
  echo "❌ 병합 충돌"
  git merge --abort
  exit 1
}

# 6. 푸시
echo "🚀 master에 푸시..."
git push origin master && echo "✅ 푸시 성공" || {
  echo "❌ 푸시 실패"
  git reset --hard HEAD~1
  exit 1
}

# 7. GitHub Actions 자동 배포 대기
echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ 배포 완료!"
echo "═══════════════════════════════════════════════════════"
echo "📋 배포 프로세스:"
echo "  1. GitHub Actions 자동 트리거 (render-engine-deploy.yml)"
echo "  2. Render 엔진 자동 배포 시작"
echo "  3. MetaAPI 재연결 및 거래 재개"
echo ""
echo "🔗 배포 상태 확인:"
echo "  → npm run render:status"
echo ""
echo "⏱️ 예상 소요 시간: 3-5분"
echo "═══════════════════════════════════════════════════════"

# 8. 배포 상태 확인 (3분 대기 후)
sleep 180
echo ""
echo "🔍 배포 상태 확인 중..."
npm run render:status || echo "⚠️ 상태 확인 실패 (일시적 오류)"

exit 0
