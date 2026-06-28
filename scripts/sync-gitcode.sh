#!/usr/bin/env bash
# 在「国内机器」上手动执行：从 GitHub latest 拉取产物，再推送到 GitCode。
# 一个入口同步两个 smartsub 依赖产物，用 --target 选择：
#   --target engine  → smartsub-py-engine runtime   (buxuku/smartsub-py-engine → buxuku1/smartsub-py-engine)
#   --target addon   → whisper.cpp addon/CUDA 产物   (buxuku/whisper.cpp       → buxuku1/whisper.node)
#
# 设计目标（应对 GitHub 境外 → GitCode 国内上传慢、且 GitCode 同名附件 PUT 不覆盖的问题）：
#   - 「下载 + 上传」整段放到国内本机执行 → 上传 GitCode 走域内网络，快且稳；
#   - GitHub 下载段可选走 ghproxy 镜像加速（USE_GHPROXY=1）；
#   - 先比对 GitHub 与 GitCode 的版本标识：一致且产物齐全则跳过，不重复传；
#   - 上传前删除 GitCode 的 tag（级联清空旧 release）再重建空 release，确保真覆盖；
#   - 仅在上传成功后删除本地临时文件。
# 共享上传引擎见 scripts/lib/gitcode-sync.sh。
#
# 用法：
#   export GITCODE_TOKEN=<你的 GitCode 个人令牌>
#   bash scripts/sync-gitcode.sh --target engine            # 同步 py-engine
#   bash scripts/sync-gitcode.sh --target addon             # 同步 whisper addon（默认走 ghproxy 下载）
#   TARGET=addon bash scripts/sync-gitcode.sh               # 等价写法
#   FORCE=1 bash scripts/sync-gitcode.sh --target engine    # 跳过新鲜度检查强制同步
#   SKIP_VERIFY=1 ...                                        # 跳过 sha256 校验
#   USE_GHPROXY=1 ... / USE_GHPROXY=0 ...                    # 覆盖该 target 的 ghproxy 默认
#   GITCODE_DRY_RUN=1 ...                                    # 预演：只打印 GitCode 改动，不真传
#
# 依赖：curl、jq；addon 额外需要 python3。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
用法: bash scripts/sync-gitcode.sh --target <addon|engine>
  --target addon    同步 whisper.cpp addon/CUDA 产物 → GitCode buxuku1/whisper.node
  --target engine   同步 smartsub-py-engine runtime  → GitCode buxuku1/smartsub-py-engine
也可用环境变量 TARGET=addon|engine 代替 --target。
常用开关: FORCE=1 SKIP_VERIFY=1 USE_GHPROXY=0|1 GITCODE_DRY_RUN=1 GITCODE_TOKEN=<token>
EOF
}

TARGET="${TARGET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "必须指定 --target addon|engine（或 TARGET 环境变量）" >&2
  usage
  exit 1
fi

# shellcheck source=scripts/lib/gitcode-sync.sh
. "$SCRIPT_DIR/lib/gitcode-sync.sh"

# --- addon 专属钩子实现（仅 --target addon 时被 case 接入）---------------------

# 校验：依据 addon-versions.json 里的 sha256 校验已下载的 CUDA/Vulkan 产物
# （macOS / CPU 版 .node 上游无 checksum，跳过）。校验清单写在 DL_DIR 之外，避免被一并上传。
addon_verify() {
  local checks="$WORKDIR/_addon_checksums.sha256"
  [ -f "$DL_DIR/addon-versions.json" ] || { echo "缺少 addon-versions.json，无法校验" >&2; exit 1; }
  (
    cd "$DL_DIR"
    python3 - <<'PY'
import json, os
with open("addon-versions.json") as f:
    data = json.load(f)

lines = []
def add(sha, name):
    if sha and os.path.isfile(name):
        lines.append(f"{sha}  {name}")

for cuda_ver, prefix in [("11.8.0","1180"),("12.2.0","1220"),("12.4.0","1240"),("13.0.2","1302")]:
    cs = (data.get(cuda_ver) or {}).get("checksum", {})
    add(cs.get("windows-tar"),  f"windows-cuda-{prefix}-optimized.tar.gz")
    add(cs.get("windows-node"), f"addon-windows-cuda-{prefix}-optimized.node.gz")
    add(cs.get("linux-tar"),    f"linux-cuda-{prefix}-optimized.tar.gz")
    add(cs.get("linux-node"),   f"addon-linux-cuda-{prefix}-optimized.node.gz")

vk = (data.get("vulkan") or {}).get("checksum", {})
add(vk.get("windows-node"), "addon-windows-vulkan.node.gz")
add(vk.get("linux-node"),   "addon-linux-vulkan.node.gz")

print("\n".join(lines))
PY
  ) > "$checks"

  if [ ! -s "$checks" ]; then
    log "  addon-versions.json 未提供可校验的 checksum，跳过校验。"
    rm -f "$checks"
    return 0
  fi
  log "  校验文件："
  sed 's/^/    /' "$checks"
  (
    cd "$DL_DIR"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$checks"; else shasum -a 256 -c "$checks"; fi
  )
  rm -f "$checks"
}

addon_update_body() {
  local build_date file_list body
  build_date=$(date -u +'%Y-%m-%d %H:%M:%S UTC')
  file_list=$(ls -1 "$DL_DIR" | sed 's/^/- `/; s/$/`/' | head -20)
  body="Latest whisper.cpp addon builds mirrored from GitHub CI.

Last synced: ${build_date}

**Build artifacts in this sync:**
${file_list}

Legacy CUDA 11.8/12.2 packages are re-uploaded on each sync."
  patch_release_body "$body"
}

# --- 两个 target 的 profile（设变量 + 接入钩子）-------------------------------
case "$TARGET" in
  engine)
    GH_REPO="${GH_REPO:-buxuku/smartsub-py-engine}"
    GITCODE_OWNER="${GITCODE_OWNER:-buxuku1}"
    GITCODE_REPO="${GITCODE_REPO:-smartsub-py-engine}"
    USE_GHPROXY="${USE_GHPROXY:-0}"
    REQUIRED_CMDS=(curl jq)
    FILES=(
      "smartsub-faster-whisper-runtime-windows-x64.tar.gz"
      "smartsub-faster-whisper-runtime-macos-arm64.tar.gz"
      "smartsub-faster-whisper-runtime-macos-x64.tar.gz"
      "smartsub-faster-whisper-runtime-linux-x64.tar.gz"
      "manifest.json"
      "checksums.sha256"
    )
    LEGACY_FILES=()
    FRESHNESS_FILE="manifest.json"
    FRESHNESS_JQ='.gitSha // empty'
    UPLOAD_FIRST=""
    TAG_MESSAGE="Latest smartsub-engine builds"
    RELEASE_NAME="latest"
    RELEASE_BODY="Auto-synced from smartsub-py-engine CI"
    do_verify() { verify_checksums_file "checksums.sha256"; }
    ;;

  addon)
    GH_REPO="${GH_REPO:-buxuku/whisper.cpp}"
    GITCODE_OWNER="${GITCODE_OWNER:-buxuku1}"
    GITCODE_REPO="${GITCODE_REPO:-whisper.node}"
    USE_GHPROXY="${USE_GHPROXY:-1}"
    REQUIRED_CMDS=(curl jq python3)
    FILES=(
      "addon-macos-x64.node"
      "addon-macos-arm64.node"
      "addon-macos-arm64-coreml.node"
      "addon-windows-x64.node"
      "addon-linux-x64.node"
      "addon-windows-cuda-1240-optimized.node.gz"
      "windows-cuda-1240-optimized.tar.gz"
      "addon-windows-cuda-1302-optimized.node.gz"
      "windows-cuda-1302-optimized.tar.gz"
      "addon-linux-cuda-1240-optimized.node.gz"
      "linux-cuda-1240-optimized.tar.gz"
      "addon-linux-cuda-1302-optimized.node.gz"
      "linux-cuda-1302-optimized.tar.gz"
      "addon-windows-vulkan.node.gz"
      "addon-linux-vulkan.node.gz"
      "addon-versions.json"
    )
    # legacy CUDA 11.8/12.2：reset 后一律重新从 GitHub 补传（仅压缩包，未压缩 .node 太大）。
    LEGACY_FILES=(
      "addon-windows-cuda-1180-optimized.node.gz"
      "windows-cuda-1180-optimized.tar.gz"
      "addon-windows-cuda-1220-optimized.node.gz"
      "windows-cuda-1220-optimized.tar.gz"
    )
    FRESHNESS_FILE="addon-versions.json"
    FRESHNESS_JQ='.'
    UPLOAD_FIRST="addon-versions.json"
    TAG_MESSAGE="Latest whisper.cpp addon builds"
    RELEASE_NAME="Latest whisper.cpp builds"
    RELEASE_BODY="Auto-synced from whisper.cpp builder CI"
    # addon-versions.json 直接镜像 GitHub 原文上传（下载已按它校验过 sha256），
    # 不在本机重算——否则会改写 version 日期，导致与 GitHub 不再一致、新鲜度永远判为「需同步」。
    do_verify() { addon_verify; }
    update_body() { addon_update_body; }
    ;;

  *)
    echo "未知 target: ${TARGET}（应为 addon 或 engine）" >&2
    usage
    exit 1
    ;;
esac

WORKDIR="${WORKDIR:-$REPO_ROOT/.gitcode-sync-tmp-$TARGET}"

run_sync
