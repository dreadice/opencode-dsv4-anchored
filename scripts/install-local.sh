#!/usr/bin/env bash
# 本地调试安装：把最新构建（含 toast 等新特性，npm 包可能是旧版）装到
# opencode 插件目录。
#
# 用法：
#   scripts/install-local.sh            # 全局：~/.config/opencode/plugins/
#   scripts/install-local.sh <dir>      # 项目：<dir>/.opencode/plugins/
#   scripts/install-local.sh --no-build # 跳过构建（用现有 dist/index.js）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

TARGET="${1:-global}"
SKIP_BUILD=false
if [ "$TARGET" = "--no-build" ]; then
  SKIP_BUILD=true
  TARGET="${2:-global}"
fi

if [ "$SKIP_BUILD" = false ]; then
  echo "==> build（esbuild bundle）"
  (cd "$ROOT" && npm run build >/dev/null)
fi

SRC="$ROOT/dist/index.js"
if [ ! -f "$SRC" ]; then
  echo "error: $SRC 不存在，先跑 npm run build" >&2
  exit 1
fi

if [ "$TARGET" = "global" ]; then
  DEST_DIR="$HOME/.config/opencode/plugins"
else
  DEST_DIR="$TARGET/.opencode/plugins"
fi

echo "==> 安装到 $DEST_DIR/dsv4-anchored.js"
mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST_DIR/dsv4-anchored.js"

echo "==> 完成。重启 opencode 生效（无热加载）。"
echo "    注意：不要与 opencode.json 的 plugin 配置同时使用（双加载）。"
