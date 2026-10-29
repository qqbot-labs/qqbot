#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "用法：scripts/start-task.sh feat/your-task" >&2
  exit 2
fi

branch=$1
case "$branch" in
  feat/*|fix/*|chore/*) ;;
  *) echo "分支必须以 feat/、fix/ 或 chore/ 开头" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区存在未提交修改，不能直接切新任务。" >&2
  exit 1
fi

git switch main
git pull --ff-only origin main
git switch -c "$branch"
echo "已创建分支：$branch"
