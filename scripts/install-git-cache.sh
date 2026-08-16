#!/usr/bin/env bash
# 预装 git 引用插件到 opencode 缓存目录（绕过 opencode v1.18.18 的
# Npm.add/Arborist 对 git spec 的安装失败——加载环节本身是好的，见
# README「安装」与 live-testing.md）。
#
# 用法：
#   scripts/install-git-cache.sh [git-spec] [cache-dir]
#   默认 git-spec = github:dreadice/opencode-dsv4-anchored
#   默认 cache-dir = ~/.cache/opencode/packages
#
# 装完后在项目 opencode.json 用原 spec 引用即可：
#   "plugin": [["github:dreadice/opencode-dsv4-anchored", {}]]
set -euo pipefail

SPEC="${1:-github:dreadice/opencode-dsv4-anchored}"
CACHE_DIR="${2:-$HOME/.cache/opencode/packages}"
# opencode 的 Npm.add 目录 = spec 原样（npa 对 git spec 的 name 为 undefined）
TARGET_DIR="$CACHE_DIR/$SPEC"

if [ -z "${GIT_SPEC_URL:-}" ]; then
  # github:user/repo -> https://github.com/user/repo
  GIT_SPEC_URL="https://github.com/${SPEC#github:}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> clone $GIT_SPEC_URL"
git clone --depth 1 "$GIT_SPEC_URL" "$TMP/repo"

echo "==> npm install（prepare 自动构建 dist；需要 devDeps）"
(
  cd "$TMP/repo"
  npm install
)

echo "==> 预装到 $TARGET_DIR"
mkdir -p "$TARGET_DIR/node_modules/$SPEC"
cp -r "$TMP/repo/." "$TARGET_DIR/node_modules/$SPEC/"

echo "==> 完成。opencode.json 配置："
echo "    \"plugin\": [[\"$SPEC\", {}]]"
echo "    更新时重跑本脚本（覆盖）。"
