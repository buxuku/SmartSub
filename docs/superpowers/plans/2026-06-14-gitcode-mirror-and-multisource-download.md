# GitCode 镜像同步修复 + 应用端多下载源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 whisper.cpp 到 GitCode 的 Release 同步（让新产物能真正覆盖旧附件），为 py-engine 增加 GitCode 同步，并让 SmartSub 应用端的 CUDA 加速包与 py-engine 都支持 github/ghproxy/gitcode 三源 + 按序自动回退。

**Architecture:** 三仓库分阶段。Part A/B 是 GitHub Actions 的 bash 同步脚本（用 GitCode `attach_files` 接口取附件 id 后 DELETE 再上传）。Part C 在 Electron 主进程加入纯函数 `getSourceFallbackOrder` 与三源 URL 构造，下载器按源序回退；渲染层把 addon 与 py-engine 统一到一个“二进制下载源”选择器。

**Tech Stack:** Bash + curl + jq（CI 脚本）；GitCode API v5；TypeScript / Electron（nextron）；React（renderer）；i18next。

**Spec:** `docs/superpowers/specs/2026-06-14-gitcode-mirror-and-multisource-download-design.md`

**测试说明:** 本项目无 jest 类运行器。纯函数用现有 `scripts/test-engine-units.ts` + `npm run test:engines`（断言 `eq`）。CI bash 脚本用 `bash -n` 语法检查 + `GITCODE_DRY_RUN=1` 干跑。整体用 `npm run build` 与 `npx tsc -p renderer/tsconfig.json` 做类型校验。

> 注：whisper.cpp 与 smartsub-py-engine 是 SmartSub 工作区外的独立仓库（绝对路径），分别在 `builder` / `main` 分支提交。两仓库的 `GITCODE_TOKEN` secret 由用户配置（同一 token）。

---

## Phase A — 修复 whisper.cpp → GitCode 同步（id 化删除）

仓库：`/Users/xiaodong/Documents/code/whisper.cpp`（分支 `builder`）

### Task A1: 在同步脚本中加入 id 化删除能力

**Files:**

- Modify: `/Users/xiaodong/Documents/code/whisper.cpp/scripts/sync-gitcode-release.sh`

**背景**：GitCode 的 `GET /releases/tags/{tag}` 详情里 `assets[]` 没有附件 id，导致 `get_attach_id_by_name`（从 `.assets` 取 id）恒为空、`delete_attachment` 空跑、覆盖失败。改为用 `GET /releases/{release_id}/attach_files`（返回带 id 列表）取 id。

- [ ] **Step 1: 新增 `get_release_id` 与 `fetch_attach_files` 函数**

在 `attachment_exists_by_name`（约第 247 行）之前插入：

```bash
# get-by-tag 详情有时不带 .id；兜底用 get-all 列表按 tag 匹配。
get_release_id() {
  local rid
  rid=$(fetch_release_json 2>/dev/null | jq -r '.id // empty')
  if [ -n "$rid" ]; then
    echo "$rid"
    return 0
  fi
  # 回退：列出全部 release，按 tag_name 匹配
  local response http_code body
  response=$(api_request GET \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases" \
    2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  if [ "$http_code" = "200" ]; then
    echo "$body" | jq -r --arg tag "$GITCODE_TAG" \
      '(if type=="array" then . else (.data // .list // []) end)[]
        | select(.tag_name == $tag) | (.id // empty)' | head -n1
  fi
}

# GitCode release 详情里的 assets 不含附件 id，必须用专门的 attach_files 列表接口取 id。
fetch_attach_files() {
  local release_id="$1"
  [ -z "$release_id" ] && { echo '[]'; return 0; }
  local response http_code body
  response=$(api_request GET \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_id}/attach_files" \
    2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  if [ "$http_code" = "200" ]; then
    echo "$body" | jq -c 'if type=="array" then . elif .data then .data elif .list then .list else (.attach_files // []) end' 2>/dev/null || echo '[]'
  else
    echo '[]'
  fi
}

# 从 attach_files 列表（含 id）里按文件名取 attach id。
attach_id_from_list() {
  local list_json="$1"
  local filename="$2"
  echo "$list_json" | jq -r --arg name "$filename" '
    .[] | select(.name == $name)
    | (.id // .attach_id // .attach_file_id // empty) | tostring
  ' | head -n1
}
```

- [ ] **Step 2: 改造 `upload_file` 使用 attach_files 列表取 id**

将 `upload_file` 中“取 release_json / 判断 replace”这段（约第 318–332 行）：

```bash
  release_json=$(fetch_release_json || echo '{}')
  release_id=$(echo "$release_json" | jq -r '.id // empty')

  if [ "$replace" = "false" ]; then
    if [ -n "$(attachment_exists_by_name "$release_json" "$filename")" ]; then
      log "  Skip (already exists): ${filename}"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
    fi
  else
    attach_id=$(get_attach_id_by_name "$release_json" "$filename")
    if [ -n "$attach_id" ] && [ -n "$release_id" ]; then
      delete_attachment "$release_id" "$attach_id" "$filename" || true
    fi
  fi
```

替换为：

```bash
  release_json=$(fetch_release_json || echo '{}')
  release_id=$(get_release_id)
  local attach_list
  attach_list=$(fetch_attach_files "$release_id")

  if [ "$replace" = "false" ]; then
    if [ -n "$(attach_id_from_list "$attach_list" "$filename")" ] || \
       [ -n "$(attachment_exists_by_name "$release_json" "$filename")" ]; then
      log "  Skip (already exists): ${filename}"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
    fi
  else
    attach_id=$(attach_id_from_list "$attach_list" "$filename")
    if [ -n "$attach_id" ] && [ -n "$release_id" ]; then
      delete_attachment "$release_id" "$attach_id" "$filename" || true
    fi
  fi
```

- [ ] **Step 3: 改造 PUT 后 already-exists 的 replace 重试路径**

将 `upload_file` 内（约第 410–421 行）：

```bash
    if asset_already_exists "$http_code" "$response_body"; then
      if [ "$replace" = "true" ]; then
        log "  Asset exists but replace requested; retry after delete (HTTP ${http_code})"
        release_json=$(fetch_release_json || echo '{}')
        release_id=$(echo "$release_json" | jq -r '.id // empty')
        attach_id=$(get_attach_id_by_name "$release_json" "$filename")
        delete_attachment "$release_id" "$attach_id" "$filename" || true
      else
```

替换为：

```bash
    if asset_already_exists "$http_code" "$response_body"; then
      if [ "$replace" = "true" ]; then
        log "  Asset exists but replace requested; retry after delete (HTTP ${http_code})"
        release_id=$(get_release_id)
        attach_list=$(fetch_attach_files "$release_id")
        attach_id=$(attach_id_from_list "$attach_list" "$filename")
        delete_attachment "$release_id" "$attach_id" "$filename" || true
      else
```

- [ ] **Step 4: 删除已废弃的 `get_attach_id_by_name`（从 `.assets` 取 id 的旧实现）**

删除函数 `get_attach_id_by_name`（约第 257–266 行整段）。保留 `attachment_exists_by_name`（仍用于存在性兜底）。

- [ ] **Step 5: 语法检查**

Run: `cd /Users/xiaodong/Documents/code/whisper.cpp && bash -n scripts/sync-gitcode-release.sh && echo OK`
Expected: 打印 `OK`，无语法错误。

- [ ] **Step 6: 干跑验证（dry-run，不需要 token 真连）**

Run:

```bash
cd /Users/xiaodong/Documents/code/whisper.cpp
mkdir -p /tmp/gc-artifacts && echo dummy > /tmp/gc-artifacts/addon-windows-x64.node
GITCODE_DRY_RUN=1 GITCODE_TOKEN=x ARTIFACTS_DIR=/tmp/gc-artifacts SYNC_SOURCE=artifacts \
  bash scripts/sync-gitcode-release.sh 2>&1 | tail -n 20
```

Expected: 流程跑通并打印 `[dry-run] ...` 计划，最后 `GitCode sync completed`（dry-run 下不真正访问网络的 PUT/DELETE）。

- [ ] **Step 7: Commit**

```bash
cd /Users/xiaodong/Documents/code/whisper.cpp
git add scripts/sync-gitcode-release.sh
git commit -m "fix(ci): delete GitCode assets by id via attach_files API so rebuilds overwrite stale packages"
```

### Task A2: 一次性补救说明（无代码）

- [ ] **Step 1: 触发一次同步清掉旧大包**

修复合入 `builder` 后，旧的 GitCode 大包仍在（之前从未删成功）。在 GitHub 仓库 `buxuku/whisper.cpp` 手动触发 `Build whisper.cpp addons` workflow（或 `workflow_dispatch` 勾选 `sync_gitcode_only=true` 仅同步），新逻辑会先删旧附件再传新包。

- [ ] **Step 2: 核对体积一致**

Run:

```bash
echo "GitHub:"; curl -sIL https://github.com/buxuku/whisper.cpp/releases/download/latest/linux-cuda-1240-optimized.tar.gz | grep -i content-length | tail -1
echo "GitCode:"; curl -sL -o /dev/null -w "%{size_download}\n" https://gitcode.com/buxuku1/whisper.node/releases/download/latest/linux-cuda-1240-optimized.tar.gz
```

Expected: 两者字节数一致（约 152MB）。

---

## Phase B — py-engine 同步到 GitCode

仓库：`/Users/xiaodong/Documents/code/smartsub-py-engine`（分支 `main`）

### Task B1: 新增自包含的 GitCode 同步脚本

**Files:**

- Create: `/Users/xiaodong/Documents/code/smartsub-py-engine/scripts/sync-gitcode-release.sh`

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Sync smartsub-py-engine build artifacts to GitCode Release (tag=latest).
# 用 attach_files 接口取附件 id 后 DELETE 再上传，确保覆盖同名旧附件。
set -euo pipefail

GITCODE_OWNER="${GITCODE_OWNER:-buxuku1}"
GITCODE_REPO="${GITCODE_REPO:-smartsub-py-engine}"
GITCODE_TAG="${GITCODE_TAG:-latest}"
GITCODE_API_URL="${GITCODE_API_URL:-https://api.gitcode.com/api/v5}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
MAX_RETRIES="${MAX_RETRIES:-3}"
GITCODE_DRY_RUN="${GITCODE_DRY_RUN:-0}"
UPLOAD_PUT_TIMEOUT="${UPLOAD_PUT_TIMEOUT:-1800}"

SYNC_FILES=(
  "smartsub-engine-windows-x64.tar.gz"
  "smartsub-engine-macos-arm64.tar.gz"
  "smartsub-engine-macos-x64.tar.gz"
  "smartsub-engine-linux-x64.tar.gz"
  "manifest.json"
  "checksums.sha256"
)

FAILED_FILES=()
UPLOADED_COUNT=0

log() { echo "$*"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
require_env() { [ -n "${GITCODE_TOKEN:-}" ] || { echo "GITCODE_TOKEN is not set" >&2; exit 1; }; }

api_request() {
  local method="$1" url="$2"; shift 2
  if [ "$GITCODE_DRY_RUN" = "1" ]; then echo "[dry-run] $method $url"; return 0; fi
  curl -sS -w "\n%{http_code}" -X "$method" -H "Authorization: Bearer ${GITCODE_TOKEN}" "$@" "$url"
}

asset_already_exists() {
  local http_code="$1" body="$2"
  [ "$http_code" = "409" ] || [ "$http_code" = "422" ] && return 0
  echo "$body" | grep -qiE 'already exist|已存在|duplicate' && return 0
  return 1
}

fetch_release_json() {
  local response http_code body
  response=$(api_request GET "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/tags/${GITCODE_TAG}" 2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1); body=$(echo "$response" | sed '$d')
  [ "$http_code" = "200" ] && { echo "$body"; return 0; }
  return 1
}

get_release_id() {
  local rid
  rid=$(fetch_release_json 2>/dev/null | jq -r '.id // empty')
  if [ -n "$rid" ]; then echo "$rid"; return 0; fi
  local response http_code body
  response=$(api_request GET "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases" 2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1); body=$(echo "$response" | sed '$d')
  [ "$http_code" = "200" ] && echo "$body" | jq -r --arg tag "$GITCODE_TAG" \
    '(if type=="array" then . else (.data // .list // []) end)[] | select(.tag_name == $tag) | (.id // empty)' | head -n1
}

fetch_attach_files() {
  local release_id="$1"; [ -z "$release_id" ] && { echo '[]'; return 0; }
  local response http_code body
  response=$(api_request GET "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_id}/attach_files" 2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1); body=$(echo "$response" | sed '$d')
  if [ "$http_code" = "200" ]; then
    echo "$body" | jq -c 'if type=="array" then . elif .data then .data elif .list then .list else (.attach_files // []) end' 2>/dev/null || echo '[]'
  else echo '[]'; fi
}

attach_id_from_list() {
  echo "$1" | jq -r --arg name "$2" '.[] | select(.name == $name) | (.id // .attach_id // .attach_file_id // empty) | tostring' | head -n1
}

delete_attachment() {
  local release_id="$1" attach_id="$2" filename="$3"
  [ -z "$attach_id" ] || [ "$attach_id" = "null" ] && return 0
  log "  Deleting existing: ${filename} (id=${attach_id})"
  [ "$GITCODE_DRY_RUN" = "1" ] && return 0
  local response http_code
  response=$(curl -sS -w "\n%{http_code}" -X DELETE -H "Authorization: Bearer ${GITCODE_TOKEN}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_id}/attach_files/${attach_id}")
  http_code=$(echo "$response" | tail -n1)
  case "$http_code" in 200|204|404) return 0 ;; *) log "  Warning: delete ${filename} HTTP ${http_code}"; return 1 ;; esac
}

ensure_release() {
  if fetch_release_json >/dev/null 2>&1; then
    log "GitCode release '${GITCODE_TAG}' exists"; return 0
  fi
  log "Creating GitCode tag and release '${GITCODE_TAG}'..."
  [ "$GITCODE_DRY_RUN" = "1" ] && return 0
  curl -sS -X POST -H "Authorization: Bearer ${GITCODE_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"${GITCODE_TAG}\",\"refs\":\"main\",\"tag_message\":\"Latest smartsub-engine builds\"}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/tags" >/dev/null || true
  local create_response create_code
  create_response=$(curl -sS -w "\n%{http_code}" -X POST -H "Authorization: Bearer ${GITCODE_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"${GITCODE_TAG}\",\"name\":\"latest\",\"body\":\"Auto-synced from smartsub-py-engine CI\",\"target_commitish\":\"main\"}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases")
  create_code=$(echo "$create_response" | tail -n1)
  if [ "$create_code" != "201" ] && [ "$create_code" != "200" ]; then
    echo "Failed to create GitCode release (HTTP ${create_code})" >&2
    echo "$create_response" | sed '$d' >&2; exit 1
  fi
}

upload_file() {
  local file_path="$1" filename release_id attach_list attach_id
  filename=$(basename "$file_path")
  [ -f "$file_path" ] || { log "  Skip missing: ${filename}"; return 0; }

  release_id=$(get_release_id)
  attach_list=$(fetch_attach_files "$release_id")
  attach_id=$(attach_id_from_list "$attach_list" "$filename")
  if [ -n "$attach_id" ] && [ -n "$release_id" ]; then
    delete_attachment "$release_id" "$attach_id" "$filename" || true
  fi

  local encoded retry curl_status http_code upload_response upload_info upload_url put_response response_body headers_file
  encoded=$(printf '%s' "$filename" | jq -sRr @uri)

  for ((retry = 0; retry < MAX_RETRIES; retry++)); do
    log "  Uploading: ${filename} (attempt $((retry + 1))/${MAX_RETRIES})"
    [ "$GITCODE_DRY_RUN" = "1" ] && { UPLOADED_COUNT=$((UPLOADED_COUNT + 1)); return 0; }

    curl_status=0
    upload_response=$(curl -sS -w "\n%{http_code}" --connect-timeout 30 --max-time 120 \
      -H "Authorization: Bearer ${GITCODE_TOKEN}" \
      "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${GITCODE_TAG}/upload_url?file_name=${encoded}") || curl_status=$?
    [ "$curl_status" -ne 0 ] && { log "  upload_url failed (curl ${curl_status})"; sleep $((10 * (retry + 1))); continue; }

    http_code=$(echo "$upload_response" | tail -n1)
    upload_info=$(echo "$upload_response" | sed '$d')
    upload_url=$(echo "$upload_info" | jq -r '.url // empty')
    if [ -z "$upload_url" ]; then
      asset_already_exists "$http_code" "$upload_info" && { log "  Already exists: ${filename}"; return 0; }
      log "  upload_url HTTP ${http_code}: ${upload_info}"; sleep $((10 * (retry + 1))); continue
    fi

    headers_file=$(mktemp)
    echo "$upload_info" | jq -r '.headers | to_entries[] | "header = \"" + .key + ": " + .value + "\""' > "$headers_file"
    curl_status=0
    put_response=$(curl -sS -w "\n%{http_code}" --connect-timeout 30 --max-time "$UPLOAD_PUT_TIMEOUT" \
      --speed-time 120 --speed-limit 10240 -K "$headers_file" -T "${file_path}" "$upload_url") || curl_status=$?
    rm -f "$headers_file"
    [ "$curl_status" -ne 0 ] && { log "  PUT failed (curl ${curl_status})"; sleep $((15 * (retry + 1))); continue; }

    http_code=$(echo "$put_response" | tail -n1)
    response_body=$(echo "$put_response" | sed '$d')
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      log "  Uploaded: ${filename}"; UPLOADED_COUNT=$((UPLOADED_COUNT + 1)); return 0
    fi
    if asset_already_exists "$http_code" "$response_body"; then
      release_id=$(get_release_id); attach_list=$(fetch_attach_files "$release_id")
      attach_id=$(attach_id_from_list "$attach_list" "$filename")
      delete_attachment "$release_id" "$attach_id" "$filename" || true
    else
      log "  Failed (HTTP ${http_code}): ${response_body}"
    fi
    sleep $((15 * (retry + 1)))
  done

  log "  ERROR: gave up uploading ${filename}"; FAILED_FILES+=("$filename"); return 1
}

main() {
  require_cmd curl; require_cmd jq; require_env
  ensure_release
  for filename in "${SYNC_FILES[@]}"; do
    upload_file "${ARTIFACTS_DIR}/${filename}" || true
    sleep 1
  done
  log "Uploaded: ${UPLOADED_COUNT}"
  if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
    echo "GitCode sync completed with failures: ${FAILED_FILES[*]}" >&2; exit 1
  fi
  log "GitCode sync completed successfully"
}

main "$@"
```

- [ ] **Step 2: 可执行 + 语法检查**

Run:

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
chmod +x scripts/sync-gitcode-release.sh
bash -n scripts/sync-gitcode-release.sh && echo OK
```

Expected: 打印 `OK`。

- [ ] **Step 3: 干跑**

Run:

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
mkdir -p /tmp/py-art && echo x > /tmp/py-art/smartsub-engine-linux-x64.tar.gz && echo y > /tmp/py-art/manifest.json
GITCODE_DRY_RUN=1 GITCODE_TOKEN=x ARTIFACTS_DIR=/tmp/py-art bash scripts/sync-gitcode-release.sh 2>&1 | tail -n 15
```

Expected: 打印各文件 `[dry-run]` 计划与 `GitCode sync completed successfully`。

- [ ] **Step 4: Commit**

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
git add scripts/sync-gitcode-release.sh
git commit -m "ci: add GitCode release sync script for py-engine"
```

### Task B2: 在 release.yml 接入同步 job

**Files:**

- Modify: `/Users/xiaodong/Documents/code/smartsub-py-engine/.github/workflows/release.yml`

- [ ] **Step 1: 在 `publish_latest` 末尾把 meta 作为 artifact 上传**

在 `publish_latest` job 的最后一步（`Publish latest release`）之后追加：

```yaml
- name: Upload meta artifact for GitCode sync
  uses: actions/upload-artifact@v4
  with:
    name: py-engine-meta
    path: |
      artifacts/manifest.json
      artifacts/checksums.sha256
    if-no-files-found: error
```

- [ ] **Step 2: 新增 `sync-gitcode-release` job**

在文件末尾（`publish_latest` 之后）追加：

```yaml
sync-gitcode-release:
  name: Sync to GitCode
  needs: publish_latest
  if: ${{ always() && needs.publish_latest.result == 'success' }}
  runs-on: ubuntu-latest
  continue-on-error: true
  steps:
    - uses: actions/checkout@v4

    - uses: actions/download-artifact@v4
      with:
        path: artifacts
        merge-multiple: true

    - name: List artifacts
      run: ls -lh artifacts/

    - name: Sync to GitCode Release
      run: bash scripts/sync-gitcode-release.sh
      env:
        GITCODE_TOKEN: ${{ secrets.GITCODE_TOKEN }}
        ARTIFACTS_DIR: artifacts
```

> `merge-multiple: true` 把 build job 的各 `py-engine-<suffix>` 与 `py-engine-meta` 一起平铺到 `artifacts/`，得到 4 个 tar.gz + manifest.json + checksums.sha256。

- [ ] **Step 3: 校验 YAML**

Run: `cd /Users/xiaodong/Documents/code/smartsub-py-engine && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"`
Expected: 打印 `YAML OK`。

- [ ] **Step 4: Commit**

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
git add .github/workflows/release.yml
git commit -m "ci: sync py-engine release artifacts to GitCode"
```

### Task B3: 配置 secret（用户执行，无代码）

- [ ] **Step 1: 设置 GITCODE_TOKEN**

由用户执行（与 whisper.cpp 同一 token）：

```bash
gh secret set GITCODE_TOKEN --repo buxuku/smartsub-py-engine
```

- [ ] **Step 2: 触发一次 workflow 验证 GitCode 出现 6 个附件**（手动）

---

## Phase C — 应用端三源下载（SmartSub）

仓库：`/Users/xiaodong/Documents/code/SmartSub`

### Task C1: 纯函数 `getSourceFallbackOrder` + 类型加 gitcode（含单测）

**Files:**

- Create: `main/helpers/downloadSourceOrder.ts`
- Modify: `types/addon.ts:268`
- Modify: `types/engine.ts:45`
- Modify: `scripts/test-engine-units.ts`

- [ ] **Step 1: 写失败测试（加到 test-engine-units.ts）**

该harness 是**顶层扁平 `eq()` 调用**（`eq` 内部已对两侧 `JSON.stringify`，可直接传数组）。

1. 在文件顶部 import 区（约第 24 行 `protocolSupport` import 之后）加：

```ts
import {
  getSourceFallbackOrder,
  DEFAULT_SOURCE_ORDER,
} from '../main/helpers/downloadSourceOrder';
```

2. 在 `console.log(\`\nengine unit tests: ...\`)`（约第 140 行）之前加：

```ts
// --- downloadSourceOrder ---
eq(
  getSourceFallbackOrder('github'),
  ['github', 'gitcode', 'ghproxy'],
  'order(github)=github,gitcode,ghproxy',
);
eq(
  getSourceFallbackOrder('ghproxy'),
  ['ghproxy', 'gitcode', 'github'],
  'order(ghproxy)=ghproxy,gitcode,github',
);
eq(
  getSourceFallbackOrder('gitcode'),
  ['gitcode', 'ghproxy', 'github'],
  'order(gitcode)=gitcode,ghproxy,github',
);
eq(
  DEFAULT_SOURCE_ORDER,
  ['gitcode', 'ghproxy', 'github'],
  'DEFAULT_SOURCE_ORDER domestic-first',
);
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npm run test:engines`
Expected: 编译/运行失败（`downloadSourceOrder` 模块不存在）。

- [ ] **Step 3: 创建纯函数模块**

Create `main/helpers/downloadSourceOrder.ts`：

```ts
/** addon 与 py-engine 共用的二进制下载源（与 HuggingFace 模型源无关）。 */
export type BinaryDownloadSource = 'github' | 'ghproxy' | 'gitcode';

/**
 * 回退规范顺序：国内优先（先域内 gitcode，再代理 ghproxy，最后直连 github）。
 * 所选源永远排第一，其余按此顺序补齐。
 */
export const DEFAULT_SOURCE_ORDER: BinaryDownloadSource[] = [
  'gitcode',
  'ghproxy',
  'github',
];

export function getSourceFallbackOrder(
  selected: BinaryDownloadSource,
): BinaryDownloadSource[] {
  return [selected, ...DEFAULT_SOURCE_ORDER.filter((s) => s !== selected)];
}
```

- [ ] **Step 4: 类型加 gitcode**

`types/addon.ts` 第 268 行：

```ts
export type DownloadSource = 'github' | 'ghproxy' | 'gitcode';
```

`types/engine.ts` 第 45 行：

```ts
export type PyEngineDownloadSource = 'github' | 'ghproxy' | 'gitcode';
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npm run test:engines`
Expected: 全部 PASS（含新增 4 条 order 断言）。

- [ ] **Step 6: Commit**

```bash
git add main/helpers/downloadSourceOrder.ts types/addon.ts types/engine.ts scripts/test-engine-units.ts
git commit -m "feat(download): add gitcode source + domestic-first fallback order helper"
```

### Task C2: addon 下载器三源 + 按序回退

**Files:**

- Modify: `main/helpers/addonDownloader.ts:23-27`（DOWNLOAD_SOURCES）
- Modify: `main/helpers/addonDownloader.ts`（新增 `getAddonVersionsUrl`、回退包装）

- [ ] **Step 1: DOWNLOAD_SOURCES 加 gitcode + 导出 versions URL 构造**

替换 `addonDownloader.ts` 第 23–27 行：

```ts
const DOWNLOAD_SOURCES: Record<DownloadSource, string> = {
  github: 'https://github.com/buxuku/whisper.cpp/releases/download/latest/',
  ghproxy:
    'https://ghfast.top/https://github.com/buxuku/whisper.cpp/releases/download/latest/',
  gitcode: 'https://gitcode.com/buxuku1/whisper.node/releases/download/latest/',
};

/** addon-versions.json 的下载地址（按源） */
export function getAddonVersionsUrl(source: DownloadSource): string {
  return `${DOWNLOAD_SOURCES[source]}addon-versions.json`;
}
```

- [ ] **Step 2: 引入回退顺序工具**

在 `addonDownloader.ts` 顶部 import 区加：

```ts
import { getSourceFallbackOrder } from './downloadSourceOrder';
```

- [ ] **Step 3: 把单源下载逻辑改为按序回退**

将 `AddonDownloader.download` 方法（第 211 行起）整体重命名其内部实现为 `downloadFromSource`，并新增对外 `download` 做回退循环。具体做法：

1. 把现有 `async download(source, variant, downloadType): Promise<string> { ... }` 的方法名改为 `private async downloadFromSource(source: DownloadSource, variant: AddonVariant, downloadType: 'node.gz' | 'tar.gz'): Promise<string> { ... }`（方法体不变）。
2. 在其上方新增：

```ts
async download(
  source: DownloadSource,
  variant: AddonVariant,
  downloadType: 'node.gz' | 'tar.gz',
): Promise<string> {
  const order = getSourceFallbackOrder(source);
  let lastError: unknown;
  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    try {
      if (i > 0) {
        logMessage(`Addon download falling back to source: ${s}`, 'warning');
      }
      return await this.downloadFromSource(s, variant, downloadType);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 用户取消：终止，不回退
      if (msg === 'Download cancelled') {
        throw error;
      }
      lastError = error;
      logMessage(
        `Addon download from ${s} failed: ${msg}; ${
          i < order.length - 1 ? 'trying next source' : 'no more sources'
        }`,
        'warning',
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}
```

> 说明：断点续传按 URL 命中，换源 URL 不同即重新开始；同源内仍续传。各源服务同一文件，校验和一致。

- [ ] **Step 4: 类型检查**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "addonDownloader|downloadSourceOrder" || echo "no errors in changed files"`
Expected: `no errors in changed files`（忽略 docs/ 等既有无关报错）。

- [ ] **Step 5: Commit**

```bash
git add main/helpers/addonDownloader.ts
git commit -m "feat(addon): gitcode base url + ordered source fallback on download"
```

### Task C3: addon-versions.json 按源回退拉取

**Files:**

- Modify: `main/helpers/addonVersions.ts:27-69`（URL 常量与 `fetchRemoteVersions`）
- Modify: `main/helpers/addonVersions.ts:378`（`getPackageDownloadSize` 调用）

- [ ] **Step 1: 改 `fetchRemoteVersions` 为按源回退**

替换第 27–69 行（`VERSIONS_URL`/`VERSIONS_URL_PROXY` 常量与 `fetchRemoteVersions`）：

```ts
import { getAddonVersionsUrl } from './addonDownloader';
import { getSourceFallbackOrder } from './downloadSourceOrder';

/**
 * 缓存的远程版本信息
 */
let cachedVersions: RemoteAddonVersions | null = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 获取远程版本信息：按所选源回退顺序依次尝试拉取 addon-versions.json。
 */
export async function fetchRemoteVersions(
  source: DownloadSource = 'github',
): Promise<RemoteAddonVersions | null> {
  if (cachedVersions && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedVersions;
  }

  const order = getSourceFallbackOrder(source);
  for (const s of order) {
    try {
      const content = await fetchJson(getAddonVersionsUrl(s));
      cachedVersions = content as RemoteAddonVersions;
      lastFetchTime = Date.now();
      logMessage(`Fetched remote addon versions from ${s}`, 'info');
      return cachedVersions;
    } catch (error) {
      logMessage(`Fetch versions from ${s} failed: ${error}`, 'warning');
    }
  }
  return null;
}
```

> 注意：删除原 `VERSIONS_URL` / `VERSIONS_URL_PROXY` 两个常量（已被 `getAddonVersionsUrl` 取代）。`import type { DownloadSource }` 保持（第 22 行已存在）。

- [ ] **Step 2: 更新 `getPackageDownloadSize` 内调用**

第 378 行：

```ts
const remoteVersions = await fetchRemoteVersions(source === 'ghproxy');
```

改为：

```ts
const remoteVersions = await fetchRemoteVersions(source);
```

- [ ] **Step 3: 类型检查**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "addonVersions" || echo "no errors in addonVersions"`
Expected: `no errors in addonVersions`。

- [ ] **Step 4: Commit**

```bash
git add main/helpers/addonVersions.ts
git commit -m "feat(addon): fetch addon-versions.json across sources with fallback"
```

### Task C4: py-engine URL builder 加 gitcode + 下载回退

**Files:**

- Modify: `main/helpers/pythonRuntime/paths.ts:181-213`
- Modify: `main/helpers/pythonRuntime/downloader.ts`（download/checkUpdate/fetchRemoteManifest 回退）

- [ ] **Step 1: paths.ts 三个 URL builder 加 gitcode**

替换 `paths.ts` 第 177–213 行：

```ts
const PY_ENGINE_GITCODE_BASE =
  'https://gitcode.com/buxuku1/smartsub-py-engine/releases/download';

function getPyEngineReleaseBaseUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  if (source === 'gitcode') {
    return `${PY_ENGINE_GITCODE_BASE}/${tag}`;
  }
  const github = `https://github.com/${PY_ENGINE_REPO}/releases/download/${tag}`;
  return source === 'ghproxy' ? `https://ghfast.top/${github}` : github;
}

export function getPyEngineDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  const asset = `smartsub-engine-${getPyEngineArtifactSuffix()}.tar.gz`;
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${asset}`;
}

export function getPyEngineChecksumsUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/checksums.sha256`;
}

export function getPyEngineManifestUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/manifest.json`;
}
```

> 这样把原先重复的 ghproxy 前缀逻辑收敛到 `getPyEngineReleaseBaseUrl`。签名类型可直接用 `PyEngineDownloadSource`，但此文件未 import 该类型，沿用字面量联合即可（与之等价）。

- [ ] **Step 2: downloader.ts 引入回退顺序**

`downloader.ts` 顶部 import 区加：

```ts
import { getSourceFallbackOrder } from '../downloadSourceOrder';
```

- [ ] **Step 3: download() 按源回退（protocol_unsupported 不回退）**

把 `async download(source: PyEngineDownloadSource): Promise<void> {` 的方法名改为 `private async downloadFromSource(source: PyEngineDownloadSource): Promise<void> {`（方法体不变）。在其上方新增：

```ts
async download(source: PyEngineDownloadSource): Promise<void> {
  const order = getSourceFallbackOrder(source);
  let lastError: unknown;
  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    try {
      if (i > 0) {
        logMessage(`Py-engine download falling back to source: ${s}`, 'warning');
      }
      await this.downloadFromSource(s);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 终止类错误：用户取消 / 协议不支持（换源无意义）
      if (
        msg === 'Download cancelled' ||
        (error instanceof PythonEngineError &&
          error.code === 'protocol_unsupported')
      ) {
        throw error;
      }
      lastError = error;
      logMessage(
        `Py-engine download from ${s} failed: ${msg}; ${
          i < order.length - 1 ? 'trying next source' : 'no more sources'
        }`,
        'warning',
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
```

> 确认 `PythonEngineError` 暴露 `code` 字段。`downloader.ts` 已 `import { PythonEngineError } from './manager';`。若其 `code` 属性名不同，按实际改判断条件。

- [ ] **Step 4: checkUpdate() 按源回退拉取 checksums/manifest**

`checkUpdate` 内拉 checksums 与 manifest 的两处分别按 `getSourceFallbackOrder(source)` 依次尝试。将第 382–395 行附近：

```ts
let remoteHash: string | null = null;
try {
  const checksumsContent = await fetchHttpText(getPyEngineChecksumsUrl(source));
  remoteHash = parseExpectedChecksum(checksumsContent, getArtifactFileName());
} catch (error) {
  logMessage(`checkUpdate: fetch checksums failed: ${error}`, 'warning');
}

const remoteManifest = await this.fetchRemoteManifest(source);
```

改为：

```ts
const order = getSourceFallbackOrder(source);
let remoteHash: string | null = null;
for (const s of order) {
  try {
    const checksumsContent = await fetchHttpText(getPyEngineChecksumsUrl(s));
    remoteHash = parseExpectedChecksum(checksumsContent, getArtifactFileName());
    if (remoteHash) break;
  } catch (error) {
    logMessage(
      `checkUpdate: fetch checksums from ${s} failed: ${error}`,
      'warning',
    );
  }
}

const remoteManifest = await this.fetchRemoteManifest(source);
```

- [ ] **Step 5: fetchRemoteManifest() 按源回退**

将 `fetchRemoteManifest`（第 356–370 行）：

```ts
  private async fetchRemoteManifest(
    source: PyEngineDownloadSource,
    tag: string = PY_ENGINE_TAG,
  ): Promise<RemoteEngineManifest | null> {
    try {
      const text = await fetchHttpText(getPyEngineManifestUrl(source, tag));
      return JSON.parse(text) as RemoteEngineManifest;
    } catch (error) {
      logMessage(
        `py-engine manifest.json unavailable (old release?): ${error}`,
        'info',
      );
      return null;
    }
  }
```

改为：

```ts
  private async fetchRemoteManifest(
    source: PyEngineDownloadSource,
    tag: string = PY_ENGINE_TAG,
  ): Promise<RemoteEngineManifest | null> {
    for (const s of getSourceFallbackOrder(source)) {
      try {
        const text = await fetchHttpText(getPyEngineManifestUrl(s, tag));
        return JSON.parse(text) as RemoteEngineManifest;
      } catch (error) {
        logMessage(
          `py-engine manifest.json from ${s} unavailable: ${error}`,
          'info',
        );
      }
    }
    return null;
  }
```

> 注意：`downloadFromSource`（原 download 体）内部对 `getPyEngineDownloadUrl/ChecksumsUrl/ManifestUrl` 已传入单一 `source`，回退由外层 `download()` 控制——但其开头自身又调用了一次 `fetchRemoteManifest(source)` 做协议校验；该调用现在已内建跨源回退，保持不变即可。

- [ ] **Step 6: 类型检查**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "pythonRuntime/(paths|downloader)" || echo "no errors in py-engine paths/downloader"`
Expected: `no errors in py-engine paths/downloader`。

- [ ] **Step 7: Commit**

```bash
git add main/helpers/pythonRuntime/paths.ts main/helpers/pythonRuntime/downloader.ts
git commit -m "feat(py-engine): gitcode urls + cross-source fallback for download/checkUpdate"
```

### Task C5: 渲染层选择器三源 + 引擎页统一源 + i18n

**Files:**

- Modify: `renderer/components/settings/gpu/gpuDownloadUtils.ts:86-94`
- Modify: `renderer/components/settings/gpu/CudaDownloadSheet.tsx:290-306`
- Modify: `renderer/components/settings/GpuAccelerationCard.tsx:185-190`
- Modify: `renderer/components/resources/EnginesTab.tsx:78-82,110-114` 等
- Modify: `renderer/public/locales/zh/settings.json`、`renderer/public/locales/en/settings.json`
- Modify: `renderer/public/locales/zh/resources.json`、`renderer/public/locales/en/resources.json`

- [ ] **Step 1: gpuDownloadUtils 持久化接受 gitcode**

替换第 86–94 行：

```ts
export function readPersistedDownloadSource(): DownloadSource {
  if (typeof window === 'undefined') return 'github';
  const v = localStorage.getItem(ADDON_DOWNLOAD_SOURCE_KEY);
  if (v === 'ghproxy' || v === 'gitcode' || v === 'github') {
    return v;
  }
  return 'github';
}

export function persistDownloadSource(source: DownloadSource): void {
  localStorage.setItem(ADDON_DOWNLOAD_SOURCE_KEY, source);
}
```

- [ ] **Step 2: CUDA 面板选择器加 gitcode**

`CudaDownloadSheet.tsx` 第 290–306 行，把数组与文案改为：

```tsx
{
  (['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map((source) => (
    <button
      key={source}
      type="button"
      disabled={isBusy}
      onClick={() => handleSourceChange(source)}
      className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
        downloadSource === source
          ? 'border-primary bg-primary/5 font-medium'
          : 'border-muted hover:border-primary/50'
      }`}
    >
      {source === 'github'
        ? 'GitHub'
        : source === 'gitcode'
          ? 'GitCode'
          : t('gpuAcceleration.ghProxy')}
    </button>
  ));
}
```

- [ ] **Step 3: GpuAccelerationCard 失败自动切源改用回退顺序**

第 185–190 行附近现有“失败硬切 ghproxy”逻辑：

```tsx
setDownloadSource('ghproxy');
persistDownloadSource('ghproxy');
```

由于主进程 `download` 现已内建跨源回退（Task C2），渲染层不再需要手动切源重试。把该“切 ghproxy 重试”分支删除（或保留为纯提示），改为提示用户“正在自动尝试其它下载源”。最小改动：删除这两行所在的自动切源 onClick/重试逻辑块，仅保留错误提示文案。

> 实现者注意：该块是失败 toast 里的“重试”动作。若删除会影响交互，可改为调用同一下载入口（不显式改 source），让主进程回退接管。

- [ ] **Step 4: EnginesTab py-engine 源改为统一二进制源**

`EnginesTab.tsx`：

1. 删除 `resolvePyEngineDownloadSource`（第 78–82 行）与对 `downSource`（第 110–114 行）在“下载源”上的依赖（`downSource` 若仅用于此则一并移除其 import 与声明；若 HF 模型相关仍在用则保留）。
2. 新增读取统一源：

```tsx
import {
  readPersistedDownloadSource,
  persistDownloadSource,
} from '@/components/settings/gpu/gpuDownloadUtils';
import type { DownloadSource } from '../../../types/addon';

// 组件内 state：
const [binarySource, setBinarySource] = useState<DownloadSource>(() =>
  typeof window === 'undefined' ? 'github' : readPersistedDownloadSource(),
);
```

3. 把原先 `const source = resolvePyEngineDownloadSource(downSource);`（第 222/238/264 行三处）改为 `const source = binarySource;`。
4. 在引擎页下载/升级区域加一个与 CUDA 面板一致的三档源选择器：

```tsx
<div className="flex gap-2">
  {(['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map((s) => (
    <button
      key={s}
      type="button"
      onClick={() => {
        setBinarySource(s);
        persistDownloadSource(s);
      }}
      className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
        binarySource === s
          ? 'border-primary bg-primary/5 font-medium'
          : 'border-muted hover:border-primary/50'
      }`}
    >
      {s === 'github' ? 'GitHub' : s === 'gitcode' ? 'GitCode' : t('ghProxy')}
    </button>
  ))}
</div>
```

> `t('ghProxy')` 用 resources 命名空间的新键（下一步加）。统一源后，addon 与 py-engine 共享 `addonDownloadSource`，用户在任一处切换都生效。

- [ ] **Step 5: i18n 文案**

`renderer/public/locales/zh/resources.json` 增加：

```json
"ghProxy": "Gh代理",
"gitcode": "GitCode"
```

`renderer/public/locales/en/resources.json` 增加：

```json
"ghProxy": "GH Proxy",
"gitcode": "GitCode"
```

（`settings.json` 已有 `gpuAcceleration.ghProxy`；GitCode 在 CUDA 面板用字面量 'GitCode'，无需新键。若 lint 要求集中管理，可加 `gpuAcceleration.gitcode`，此处保持字面量即可。）

- [ ] **Step 6: 渲染层类型检查**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npx tsc -p renderer/tsconfig.json --noEmit 2>&1 | grep -E "EnginesTab|CudaDownloadSheet|GpuAccelerationCard|gpuDownloadUtils" || echo "no errors in changed renderer files"`
Expected: `no errors in changed renderer files`。

- [ ] **Step 7: Commit**

```bash
git add renderer/components/settings/gpu/gpuDownloadUtils.ts \
  renderer/components/settings/gpu/CudaDownloadSheet.tsx \
  renderer/components/settings/GpuAccelerationCard.tsx \
  renderer/components/resources/EnginesTab.tsx \
  renderer/public/locales/zh/resources.json \
  renderer/public/locales/en/resources.json
git commit -m "feat(ui): unified github/ghproxy/gitcode source selector for addon + py-engine"
```

### Task C6: 全量构建 + 单测 + 收尾

- [ ] **Step 1: 单测**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npm run test:engines`
Expected: 全 PASS。

- [ ] **Step 2: 构建**

Run: `cd /Users/xiaodong/Documents/code/SmartSub && npm run build`
Expected: 构建成功（无类型错误）。

- [ ] **Step 3: 手动冒烟清单（无代码，逐项确认）**

- 设置页 CUDA 面板出现三档：GitHub / Gh代理 / GitCode；切换后 `localStorage.addonDownloadSource` 更新。
- 引擎页 py-engine 出现同样三档，且与 CUDA 面板共享选择（切一处另一处同步）。
- 选 GitCode 下载 py-engine 成功（依赖 Phase B 已同步）。
- 断开/选一个不可用源，下载自动回退到下一个源（日志可见 `falling back to source`）。

- [ ] **Step 4: 最终提交（若冒烟有微调）**

```bash
git add -A
git commit -m "chore: finalize multi-source download wiring"
```

---

## Self-Review

**Spec coverage:**

- Part A（id 化删除 + release_id 兜底 + 一次性补救）→ Task A1/A2 ✓
- Part B（自包含同步脚本 + CI job + secret）→ Task B1/B2/B3 ✓
- Part C 源类型/URL/回退/版本与 manifest 拉取/UI/i18n → Task C1–C6 ✓
- GitCode 下载 URL 用 `gitcode.com` 主机 → C2/C4 基址 ✓
- 回退顺序 `[selected, gitcode, ghproxy, github]` 去重 → C1 helper + 单测 ✓
- 终止不回退（取消 / protocol_unsupported）→ C2/C4 ✓

**Placeholder scan:** 无 TBD/TODO；每个改动给了具体代码或精确行号定位。

**Type consistency:** `BinaryDownloadSource` 与 `DownloadSource`/`PyEngineDownloadSource` 均为 `'github'|'ghproxy'|'gitcode'`，结构一致可互传；`getSourceFallbackOrder` 名称在 C1/C2/C3/C4 一致；`getAddonVersionsUrl` 在 C2 定义、C3 使用一致。

**已知裁剪点（实现时按实际微调，不阻断）：**

- `PythonEngineError.code`（`manager.ts:26` 为 `code: string`）已确认，`error.code === 'protocol_unsupported'` 可用。
- EnginesTab 中 `downSource` 若仍服务于 HF 模型下载，仅解除其与“二进制源”的耦合，不删除模型相关用途。
- GpuAccelerationCard 失败重试块的具体交互按现有代码就近调整（核心是不再硬切 ghproxy）。
