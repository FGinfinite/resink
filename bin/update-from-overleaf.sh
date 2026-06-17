#!/bin/bash
# 从 Overleaf 上游更新代码

set -e

echo "🔄 开始更新 Overleaf 上游代码..."
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查当前分支
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo -e "${RED}❌ 错误：请先切换到 main 分支${NC}"
  echo "   执行：git checkout main"
  exit 1
fi

# 检查是否有未提交的改动
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}❌ 错误：有未提交的改动${NC}"
  echo "   请先提交：git add . && git commit -m 'your message'"
  exit 1
fi

# 检查是否已添加 upstream
if ! git remote | grep -q "^upstream$"; then
  echo "📥 添加 Overleaf 上游仓库..."
  git remote add upstream https://github.com/overleaf/overleaf.git
fi

echo "📡 拉取上游最新代码（这可能需要几分钟）..."
if ! git fetch upstream --tags; then
  echo -e "${RED}❌ 网络错误：无法连接到 GitHub${NC}"
  echo ""
  echo "解决方案："
  echo "1. 检查网络连接"
  echo "2. 使用代理：export https_proxy=your_proxy"
  echo "3. 使用 SSH：git remote set-url upstream git@github.com:overleaf/overleaf.git"
  exit 1
fi

echo ""
echo -e "${GREEN}✅ 成功拉取上游代码${NC}"
echo ""

# 显示版本差异
echo "📊 版本差异统计："
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 计算落后的提交数
behind_count=$(git log main..upstream/main --oneline | wc -l)
ahead_count=$(git log upstream/main..main --oneline | wc -l)

echo "📉 落后上游: ${behind_count} 个提交"
echo "📈 领先上游: ${ahead_count} 个提交（你的自定义功能）"
echo ""

# 显示上游最近的提交
echo "🆕 上游最近 10 个提交："
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
git log upstream/main --oneline --date=short --format="%C(yellow)%h%C(reset) %C(green)%ad%C(reset) %s" -10
echo ""

# 显示你最后一次合并的时间
last_merge=$(git log --grep="Merge.*upstream\|Overleaf" --date=short --format="%ad" -1)
echo "⏰ 上次合并时间: ${last_merge}"
echo ""

# 询问是否继续
echo -e "${YELLOW}⚠️  警告：合并可能会产生冲突，特别是以下文件：${NC}"
echo "   - services/web/frontend/* (你的 AI 功能)"
echo "   - services/web/app/src/router.mjs (路由改动)"
echo "   - services/*/Dockerfile (Docker 配置)"
echo "   - services/web/config/settings.defaults.js (配置改动)"
echo ""

read -p "是否继续更新？(y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "取消更新"
  exit 0
fi

echo ""
echo "🔀 创建更新分支..."
update_branch="feature/update-overleaf-$(date +%Y%m%d)"
git checkout -b "$update_branch"

echo ""
echo "🔀 开始合并上游代码..."
echo ""

if git merge upstream/main --no-edit; then
  echo ""
  echo -e "${GREEN}✅ 合并成功！无冲突${NC}"
  echo ""
  echo "📋 下一步："
  echo "   1. 测试功能：cd develop && ./bin/smoke"
  echo "   2. 如果测试通过："
  echo "      git checkout main"
  echo "      git merge $update_branch"
  echo "      ./bin/sync-to-public.sh"
  echo "   3. 如果测试失败："
  echo "      git checkout main"
  echo "      git branch -D $update_branch"
else
  echo ""
  echo -e "${YELLOW}⚠️  发现冲突！${NC}"
  echo ""
  echo "📋 解决冲突步骤："
  echo "   1. 查看冲突文件：git status"
  echo "   2. 编辑冲突文件，搜索 '<<<<<<' 标记"
  echo "   3. 解决后标记：git add <文件>"
  echo "   4. 完成合并：git commit"
  echo "   5. 测试：cd develop && ./bin/smoke"
  echo "   6. 如果成功："
  echo "      git checkout main"
  echo "      git merge $update_branch"
  echo "      ./bin/sync-to-public.sh"
  echo ""
  echo "💡 如果冲突太多，可以考虑："
  echo "   - 放弃本次合并：git merge --abort"
  echo "   - 使用渐进式更新（一次合并几个提交）"
  echo ""

  exit 1
fi
