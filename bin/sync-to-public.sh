#!/bin/bash
# 同步开发分支到公开分支（自动排除开发文档）

set -e

echo "🔄 开始同步到公开分支..."

# 确保当前在 main 分支
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo "❌ 错误：请先切换到 main 分支"
  echo "   执行：git checkout main"
  exit 1
fi

# 检查是否有未提交的改动
if ! git diff-index --quiet HEAD --; then
  echo "❌ 错误：main 分支有未提交的改动"
  echo "   请先提交：git add . && git commit -m 'your message'"
  exit 1
fi

# 切换到 public 分支
echo "📂 切换到 public 分支..."
git checkout public

# 合并 main 的改动（不自动提交）
echo "🔀 合并 main 分支的改动..."
if ! git merge main --no-commit --no-ff; then
  echo "❌ 合并冲突！请手动解决后执行："
  echo "   git add ."
  echo "   git commit -m 'merge from main'"
  echo "   git push github-public public:main"
  exit 1
fi

# 定义要排除的开发文档模式
echo "🧹 清理开发文档..."
EXCLUDE_PATTERNS=(
  "AGENTS.md"
  "CLAUDE.md"
  "*/CLAUDE.md"
  "OVERLEAF-PATCHES.md"
  "BRAND-CUSTOMIZATION.md"
  "OVERLEAF-SERVERO-DIFF.md"
  ".claude/"
  ".trellis/"
  ".github/"
  "develop/"
  "docs/"
  "deploy/"
)

# 取消暂存开发文档
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  git restore --staged "$pattern" 2>/dev/null || true
done

# 恢复这些文件到删除状态（保持 public 分支干净）
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  git checkout HEAD -- "$pattern" 2>/dev/null || true
done

# 提交合并后的改动
echo "💾 提交改动..."
commit_msg="Merge from main branch

$(git log public..main --oneline)"

git commit -m "$commit_msg" || {
  echo "⚠️  没有新的改动需要提交"
  git checkout main
  exit 0
}

# 推送到公开仓库
echo "🚀 推送到公开仓库..."
git push github-public public:main

# 切回开发分支
echo "🔙 切回 main 分支..."
git checkout main

echo ""
echo "✅ 同步完成！"
echo "📊 公开仓库已更新：https://github.com/FGinfinite/resink"
echo ""
