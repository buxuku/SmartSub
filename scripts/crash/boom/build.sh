#!/usr/bin/env bash
# 编译烟测用的 boom 样本库（Linux / macOS，用 cc）。
# 用法：build.sh <输出目录>
set -euo pipefail

out="$1"
src="$(cd "$(dirname "$0")" && pwd)/boom.c"
mkdir -p "$out"

build() {
  local name="$1"
  shift
  cc -shared -fPIC "$@" -o "$out/$name.node" "$src"
}

build boom-ill -DBOOM_ILL
build boom-segv
build boom-abort -DBOOM_ABORT
build boom-ill-init -DBOOM_ILL -DBOOM_ON_LOAD

ls -la "$out"
