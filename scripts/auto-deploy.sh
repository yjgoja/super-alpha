#!/bin/bash
# 자동 배포 스크립트
# 모든 변경사항을 자동으로 커밋하고 푸시

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# 현재 브랜치 확인
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📌 현재 브랜치: $CURRENT_BRANCH"

# 변경사항 확인
if git diff-index --quiet HEAD --; then
    echo "✅ 변경사항 없음"
    exit 0
fi

# staged 변경사항 확인
if ! git diff-index --cached --quiet HEAD --; then
    echo "📝 변경사항 감지됨, 커밋 진행..."
    git add -A

    COMMIT_MSG="chore: auto-deploy $(date +'%Y-%m-%d %H:%M:%S')"
    git commit -m "$COMMIT_MSG" || echo "⚠️ 커밋 실패 (변경사항 없음)"
else
    echo "📝 Unstaged 변경사항 감지"
    git add -A
    COMMIT_MSG="chore: auto-deploy $(date +'%Y-%m-%d %H:%M:%S')"
    git commit -m "$COMMIT_MSG" || echo "⚠️ 커밋 실패"
fi

# 푸시
echo "🚀 푸시 진행..."
git push origin $CURRENT_BRANCH || echo "⚠️ 푸시 실패"

echo "✅ 배포 완료"
echo "📊 GitHub Actions가 자동으로 배포를 진행합니다"
