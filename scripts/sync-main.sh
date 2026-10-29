#!/usr/bin/env bash
set -euo pipefail

# 只做快进同步，绝不覆盖本地未提交修改。
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区存在未提交修改，已停止同步。请先提交或妥善保存。" >&2
  exit 1
fi

current=$(git branch --show-current)
if [ "$current" != "main" ]; then
  git switch main
fi

git fetch origin main
git merge --ff-only origin/main

echo "已同步到最新 main："
git log -1 --oneline
git status --short --branch
