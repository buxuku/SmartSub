#!/usr/bin/env bash
# 共享的 GitCode 同步引擎（被 scripts/sync-gitcode.sh source，不单独执行）。
#
# 职责：与 GitCode Release API 打交道（创建/重置 release、列附件、删/传文件、重试），
#       以及「下载 GitHub 产物 → 校验 → 重置 release → 上传」的通用骨架 run_sync。
# 产物无关：具体同步哪些文件、如何校验、是否生成 versions.json / 补传 legacy，全部由
#           入口脚本通过变量 + 钩子函数（do_verify / prepare_extra / update_body）注入。
#
# 关键修复（与 smartsub / whisper.cpp 历史问题一致）：
#   GitCode 对「同名附件」的 PUT 上传不会覆盖旧内容，按 id 定点删除单个附件也不可靠
#   （release / attach 的数字 id 偶发取不到，导致预删被跳过、随后取 upload_url 命中
#   「已存在」而假成功，远端始终是旧内容）。唯一可靠刷新办法：删除 tag（GitCode 级联
#   删除该 release 及其全部附件）→ 重建空 release → 所有文件按全新名字上传。

# --- 通用基础设施默认值（产物相关的变量由入口 profile 设置）-------------------
GITCODE_API_URL="${GITCODE_API_URL:-https://api.gitcode.com/api/v5}"
GITCODE_TAG="${GITCODE_TAG:-latest}"
GH_TAG="${GH_TAG:-latest}"
MAX_RETRIES="${MAX_RETRIES:-3}"
GITCODE_DRY_RUN="${GITCODE_DRY_RUN:-0}"
GHPROXY_BASE="${GHPROXY_BASE:-https://gh-proxy.com}"
FORCE="${FORCE:-0}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"
# Per-file PUT timeout（秒）。-T 流式 + 健康 GitCode（~10MB/s）下，1.4GB 包约 ~150s 完成；
# 1800s 留足余量，同时给「GitCode 退化」的尝试设上界，避免挂死数小时。
UPLOAD_PUT_TIMEOUT="${UPLOAD_PUT_TIMEOUT:-1800}"
LEGACY_PUT_TIMEOUT="${LEGACY_PUT_TIMEOUT:-1800}"

FAILED_FILES=()
UPLOADED_COUNT=0
SKIPPED_COUNT=0

log() { echo "[sync] $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }
}

require_env() {
  [ -n "${GITCODE_TOKEN:-}" ] || {
    echo "GITCODE_TOKEN is not set（需要 GitCode 个人令牌）" >&2
    exit 1
  }
}

# --- URL 构造 -----------------------------------------------------------------
# GitHub 下载基址（USE_GHPROXY=1 时前置 ghproxy 镜像加速）
gh_base() {
  local base="https://github.com/${GH_REPO}/releases/download/${GH_TAG}"
  if [ "${USE_GHPROXY:-0}" = "1" ]; then echo "${GHPROXY_BASE}/${base}"; else echo "$base"; fi
}
gh_url() { echo "$(gh_base)/$1"; }
gitcode_url() { echo "https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}/releases/download/${GITCODE_TAG}/$1"; }

# 读取远端文件内容（取不到返回空，不报错）
remote_fetch() { curl -fsSL --connect-timeout 20 --max-time 120 "$1" 2>/dev/null || true; }

# GitCode 上 FILES 是否齐全（任一缺失即返回非 0）。
# 注意：GitCode 对 release 资源的 HEAD 请求一律返回 401，不能用 curl -I 探测存在性
# （会被误判为缺失，导致新鲜度检查永远认为「需要同步」）；改用 GET 首字节（-r 0-0，
# 命中返回 206 / 200），既能判断存在又几乎不下载内容。
gitcode_has_all_files() {
  local name
  for name in "${FILES[@]}"; do
    curl -fsL -r 0-0 --connect-timeout 20 --max-time 60 -o /dev/null "$(gitcode_url "$name")" >/dev/null 2>&1 || return 1
  done
  return 0
}

# --- GitCode API --------------------------------------------------------------
api_request() {
  local method="$1" url="$2"
  shift 2
  if [ "$GITCODE_DRY_RUN" = "1" ]; then
    echo "[dry-run] $method $url"
    return 0
  fi
  curl -sS -w "\n%{http_code}" -X "$method" \
    -H "Authorization: Bearer ${GITCODE_TOKEN}" "$@" "$url"
}

asset_already_exists() {
  local http_code="$1" body="$2"
  if [ "$http_code" = "409" ] || [ "$http_code" = "422" ]; then return 0; fi
  echo "$body" | grep -qiE 'already exist|已存在|duplicate' && return 0
  return 1
}

fetch_release_json() {
  local response http_code body
  response=$(api_request GET \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/tags/${GITCODE_TAG}" \
    2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  [ "$http_code" = "200" ] && { echo "$body"; return 0; }
  return 1
}

# get-by-tag 详情有时不带 .id；兜底用 get-all 列表按 tag 匹配。
get_release_id() {
  local rid
  rid=$(fetch_release_json 2>/dev/null | jq -r '.id // empty')
  if [ -n "$rid" ]; then echo "$rid"; return 0; fi
  local response http_code body
  response=$(api_request GET \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases" \
    2>/dev/null || true)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  [ "$http_code" = "200" ] && echo "$body" | jq -r --arg tag "$GITCODE_TAG" \
    '(if type=="array" then . else (.data // .list // []) end)[]
      | select(.tag_name == $tag) | (.id // empty)' | head -n1
}

# release 详情里的 assets 不含附件 id，必须用专门的 attach_files 列表接口取 id。
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

attach_id_from_list() {
  echo "$1" | jq -r --arg name "$2" \
    '.[] | select(.name == $name) | (.id // .attach_id // .attach_file_id // empty) | tostring' | head -n1
}

# release 详情按名判断存在性（详情 assets 有 name 无 id，仅作存在性兜底）。
attachment_exists_by_name() {
  echo "$1" | jq -r --arg name "$2" '
    (.assets // .attach_files // [])[]
    | select(.name == $name and (.type // "attach") != "source")
    | .name' | head -n1
}

file_size_bytes() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

human_size() {
  local bytes="$1"
  if [ "$bytes" -lt 1048576 ]; then echo "$((bytes / 1024))KB"; else echo "$((bytes / 1048576))MB"; fi
}

delete_attachment() {
  local release_id="$1" attach_id="$2" filename="$3"
  { [ -z "$attach_id" ] || [ "$attach_id" = "null" ]; } && return 0
  log "  Deleting existing attachment: ${filename} (id=${attach_id})"
  [ "$GITCODE_DRY_RUN" = "1" ] && return 0
  local response http_code
  response=$(curl -sS -w "\n%{http_code}" -X DELETE \
    -H "Authorization: Bearer ${GITCODE_TOKEN}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_id}/attach_files/${attach_id}")
  http_code=$(echo "$response" | tail -n1)
  case "$http_code" in
    200 | 204 | 404) return 0 ;;
    *) log "  Warning: delete ${filename} returned HTTP ${http_code}"; return 1 ;;
  esac
}

# 创建 tag + release（假定 tag 不存在；reset_release 会先删旧 tag 再调用本函数）。
create_release() {
  log "Creating GitCode tag and release '${GITCODE_TAG}'..."
  [ "$GITCODE_DRY_RUN" = "1" ] && { log "[dry-run] would create tag and release"; return 0; }

  local tag_response tag_code
  tag_response=$(curl -sS -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer ${GITCODE_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"${GITCODE_TAG}\",\"refs\":\"main\",\"tag_message\":\"${TAG_MESSAGE}\"}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/tags" || true)
  tag_code=$(echo "$tag_response" | tail -n1)
  if [ "$tag_code" != "201" ] && [ "$tag_code" != "200" ]; then
    log "Tag create returned HTTP ${tag_code} (may already exist, continuing)"
  fi

  local create_response create_code
  create_response=$(curl -sS -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer ${GITCODE_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"${GITCODE_TAG}\",\"name\":\"${RELEASE_NAME}\",\"body\":\"${RELEASE_BODY}\",\"target_commitish\":\"main\"}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases")
  create_code=$(echo "$create_response" | tail -n1)
  if [ "$create_code" != "201" ] && [ "$create_code" != "200" ]; then
    echo "Failed to create GitCode release (HTTP ${create_code})" >&2
    echo "$create_response" | sed '$d' >&2
    exit 1
  fi
  log "Created GitCode release '${GITCODE_TAG}'"
}

# 删除 tag（级联删除 release + 全部附件）→ 等后端传播 → 重建空 release。
reset_release() {
  log "Resetting GitCode release '${GITCODE_TAG}' (delete tag -> recreate, the only reliable way to overwrite assets) ..."
  if [ "$GITCODE_DRY_RUN" = "1" ]; then
    log "[dry-run] would delete tag '${GITCODE_TAG}' and recreate release"
    create_release
    return 0
  fi
  curl -sS -o /dev/null -w "  delete tag ${GITCODE_TAG} -> %{http_code}\n" \
    -X DELETE -H "Authorization: Bearer ${GITCODE_TOKEN}" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/tags/${GITCODE_TAG}" || true
  # 等删除在 GitCode 后端传播，避免重建/上传命中残留索引（GET 不再 200 即视为已删）
  local i
  for i in 1 2 3 4 5 6; do
    sleep 2
    fetch_release_json >/dev/null 2>&1 || break
  done
  create_release
}

# 上传单个文件。replace=true：当前构建产物，需覆盖（reset 后通常无冲突，仍按覆盖处理）；
#                replace=false：legacy「缺失才补传」，已存在即合法跳过。
upload_file() {
  local file_path="$1" replace="${2:-false}" put_timeout="${3:-$UPLOAD_PUT_TIMEOUT}"
  local filename release_json release_id attach_list attach_id file_size
  filename=$(basename "$file_path")
  [ -f "$file_path" ] || { log "  Skip missing file: ${filename}"; return 0; }
  file_size=$(file_size_bytes "$file_path")

  release_json=$(fetch_release_json || echo '{}')
  release_id=$(get_release_id)
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

  local encoded retry curl_status http_code upload_response upload_info upload_url put_response response_body headers_file
  encoded=$(printf '%s' "$filename" | jq -sRr @uri)

  for ((retry = 0; retry < MAX_RETRIES; retry++)); do
    log "  Uploading: ${filename} ($(human_size "$file_size"), attempt $((retry + 1))/${MAX_RETRIES})"
    if [ "$GITCODE_DRY_RUN" = "1" ]; then
      UPLOADED_COUNT=$((UPLOADED_COUNT + 1))
      return 0
    fi

    curl_status=0
    upload_response=$(curl -sS -w "\n%{http_code}" --connect-timeout 30 --max-time 120 \
      -H "Authorization: Bearer ${GITCODE_TOKEN}" \
      "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${GITCODE_TAG}/upload_url?file_name=${encoded}") || curl_status=$?
    if [ "$curl_status" -ne 0 ]; then
      log "  Failed to get upload URL (curl exit ${curl_status})"
      sleep $((10 * (retry + 1)))
      continue
    fi

    http_code=$(echo "$upload_response" | tail -n1)
    upload_info=$(echo "$upload_response" | sed '$d')
    upload_url=$(echo "$upload_info" | jq -r '.url // empty')

    if [ -z "$upload_url" ]; then
      if asset_already_exists "$http_code" "$upload_info"; then
        # replace=true 时报「已存在」说明预删未生效（同名旧附件仍在）。绝不能当成功返回，
        # 否则文件没真正上传、GitCode 仍是旧内容（「假成功」）；重取 id 强删后重试，重试
        # 耗尽仍删不掉则落到 FAILED_FILES 真报错。replace=false 时「已存在」才是合法跳过。
        if [ "$replace" = "true" ]; then
          log "  Asset still exists (pre-delete missed); re-deleting & retrying: ${filename}"
          release_id=$(get_release_id)
          attach_list=$(fetch_attach_files "$release_id")
          attach_id=$(attach_id_from_list "$attach_list" "$filename")
          delete_attachment "$release_id" "$attach_id" "$filename" || true
          sleep $((5 * (retry + 1)))
          continue
        fi
        log "  Already exists: ${filename}"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        return 0
      fi
      log "  Failed to get upload URL (HTTP ${http_code}): ${upload_info}"
      sleep $((10 * (retry + 1)))
      continue
    fi

    headers_file=$(mktemp)
    echo "$upload_info" | jq -r '.headers | to_entries[] | "header = \"" + .key + ": " + .value + "\""' > "$headers_file"

    curl_status=0
    # 不用 --retry-all-errors（PUT 失败会从头重传 GB 级文件）。用 -T 流式上传（避免
    # --data-binary @file 把整文件读进内存 OOM）。--speed-time/--speed-limit 在连接
    # 接近僵死（GitCode 退化）时 ~2min 内中断，转为重试而非挂到 max-time。
    put_response=$(curl -sS -w "\n%{http_code}" \
      --connect-timeout 30 --max-time "$put_timeout" \
      --speed-time 120 --speed-limit 10240 \
      -K "$headers_file" -T "${file_path}" "$upload_url") || curl_status=$?
    rm -f "$headers_file"

    if [ "$curl_status" -ne 0 ]; then
      if [ "$curl_status" -eq 28 ]; then
        log "  Upload timed out after ${put_timeout}s: ${filename}"
      else
        log "  Upload request failed (curl exit ${curl_status})"
      fi
      sleep $((15 * (retry + 1)))
      continue
    fi

    http_code=$(echo "$put_response" | tail -n1)
    response_body=$(echo "$put_response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      log "  Uploaded: ${filename}"
      UPLOADED_COUNT=$((UPLOADED_COUNT + 1))
      return 0
    fi

    if asset_already_exists "$http_code" "$response_body"; then
      if [ "$replace" = "true" ]; then
        log "  Asset exists but replace requested; retry after delete (HTTP ${http_code})"
        release_id=$(get_release_id)
        attach_list=$(fetch_attach_files "$release_id")
        attach_id=$(attach_id_from_list "$attach_list" "$filename")
        delete_attachment "$release_id" "$attach_id" "$filename" || true
      else
        log "  Already exists: ${filename}"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        return 0
      fi
    else
      log "  Failed (HTTP ${http_code}), response: ${response_body}"
    fi
    sleep $((15 * (retry + 1)))
  done

  log "  ERROR: gave up uploading ${filename}"
  FAILED_FILES+=("$filename")
  return 1
}

# 按体积从小到大排序（小文件先传，便于快速看到进展）。
sort_files_by_size() {
  local -a paths=("$@") sorted=()
  local path size line
  while IFS= read -r line; do sorted+=("$line"); done < <(
    for path in "${paths[@]}"; do
      size=$(file_size_bytes "$path")
      printf '%s\t%s\n' "$size" "$path"
    done | sort -n | cut -f2-
  )
  printf '%s\n' "${sorted[@]}"
}

# PATCH release 描述（供 update_body 钩子调用）。
patch_release_body() {
  local body="$1" release_id
  release_id=$(get_release_id)
  [ -n "$release_id" ] || return 0
  if [ "$GITCODE_DRY_RUN" = "1" ]; then log "[dry-run] would update release body"; return 0; fi
  curl -sS -X PATCH \
    -H "Authorization: Bearer ${GITCODE_TOKEN}" -H "Content-Type: application/json" \
    -d "$(jq -n --arg tag "$GITCODE_TAG" --arg name "${RELEASE_NAME}" --arg body "$body" \
      '{tag_name:$tag,name:$name,body:$body}')" \
    "${GITCODE_API_URL}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_id}" >/dev/null
  log "Updated GitCode release description"
}

# --- 通用步骤 -----------------------------------------------------------------
download_files() {
  log "需要同步 → 下载 ${GH_REPO} ${GH_TAG} 产物到 $DL_DIR"
  mkdir -p "$DL_DIR"
  local name
  for name in "${FILES[@]}"; do
    log "  下载: $name"
    curl -fL --retry 3 --retry-delay 5 \
      --connect-timeout 30 --max-time 3600 \
      -o "$DL_DIR/$name" "$(gh_url "$name")"
  done
}

# 复用：按 checksums 文件校验（sha256sum / shasum 兜底）。
verify_checksums_file() {
  (
    cd "$DL_DIR"
    local f="${1:-checksums.sha256}"
    [ -f "$f" ] || { echo "缺少 ${f}，无法校验" >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$f"; else shasum -a 256 -c "$f"; fi
  )
}

# reset 后从干净 release 全新上传当前产物（UPLOAD_FIRST 优先，其余按体积从小到大）。
upload_build_files() {
  log "=== 上传当前构建产物到 GitCode（reset 后全新上传，小文件优先）==="
  shopt -s nullglob
  local files=("$DL_DIR"/*)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || { echo "工作目录无文件: $DL_DIR" >&2; exit 1; }

  local -a ordered=() rest=()
  local first_path="" fp
  if [ -n "${UPLOAD_FIRST:-}" ] && [ -f "$DL_DIR/$UPLOAD_FIRST" ]; then
    first_path="$DL_DIR/$UPLOAD_FIRST"
    ordered+=("$first_path")
  fi
  for fp in "${files[@]}"; do
    [ -n "$first_path" ] && [ "$fp" = "$first_path" ] && continue
    rest+=("$fp")
  done
  if [ "${#rest[@]}" -gt 0 ]; then
    while IFS= read -r fp; do [ -n "$fp" ] && ordered+=("$fp"); done < <(sort_files_by_size "${rest[@]}")
  fi

  for fp in "${ordered[@]}"; do
    upload_file "$fp" true || true
    sleep 1
  done
}

# legacy「缺失才补传」（reset 后 release 为空，因此每次都会重新补传）。LEGACY_FILES 为空则跳过。
sync_legacy_files() {
  [ "${#LEGACY_FILES[@]}" -gt 0 ] || return 0
  local legacy_dir="${WORKDIR}/legacy_files"
  mkdir -p "$legacy_dir"
  log "=== legacy 资产（reset 后一律从 GitHub 重新补传）==="
  local filename release_json dest
  for filename in "${LEGACY_FILES[@]}"; do
    release_json=$(fetch_release_json || echo '{}')
    if [ -n "$(attachment_exists_by_name "$release_json" "$filename")" ]; then
      log "  Skip (already on GitCode): ${filename}"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    dest="${legacy_dir}/${filename}"
    log "  从 GitHub 下载 legacy: ${filename}"
    if ! curl -fsSL --connect-timeout 30 --max-time 3600 -o "$dest" "$(gh_url "$filename")"; then
      log "  Warning: GitHub 上没有该 legacy 文件，跳过: ${filename}"
      rm -f "$dest"
      continue
    fi
    upload_file "$dest" false "$LEGACY_PUT_TIMEOUT" || true
  done
}

cleanup_local() { rm -rf "$WORKDIR"; }

# 新鲜度：GitHub / GitCode 的 FRESHNESS_FILE 经 jq -S 提取的 key 一致，且 GitCode 上 FILES 齐全。
freshness_is_uptodate() {
  local gh_key gc_key
  gh_key="$(remote_fetch "$(gh_url "$FRESHNESS_FILE")" | jq -S "$FRESHNESS_JQ" 2>/dev/null || true)"
  gc_key="$(remote_fetch "$(gitcode_url "$FRESHNESS_FILE")" | jq -S "$FRESHNESS_JQ" 2>/dev/null || true)"
  if [ -n "$gh_key" ] && [ "$gh_key" = "$gc_key" ] && gitcode_has_all_files; then
    return 0
  fi
  [ -n "$gh_key" ] || log "  读取 GitHub ${FRESHNESS_FILE} 失败（可调整 USE_GHPROXY 重试），继续同步。"
  return 1
}

# --- 产物相关钩子（入口 profile 按需覆盖）------------------------------------
do_verify() { :; }       # 校验下载完整性
prepare_extra() { :; }   # 上传前的额外准备（可选钩子；当前 addon/engine 都不需要）
update_body() { :; }     # 上传后更新 release 描述

# --- 通用骨架 -----------------------------------------------------------------
run_sync() {
  : "${GH_REPO:?GH_REPO 未设置（profile 应提供）}"
  : "${GITCODE_OWNER:?GITCODE_OWNER 未设置}"
  : "${GITCODE_REPO:?GITCODE_REPO 未设置}"
  : "${FRESHNESS_FILE:?FRESHNESS_FILE 未设置}"
  : "${WORKDIR:?WORKDIR 未设置}"
  DL_DIR="$WORKDIR/artifacts"

  local c
  for c in "${REQUIRED_CMDS[@]}"; do require_cmd "$c"; done
  require_env

  if [ "$FORCE" != "1" ]; then
    log "比对 GitHub / GitCode 的 ${FRESHNESS_FILE} ..."
    if freshness_is_uptodate; then
      log "GitCode 已是最新（${FRESHNESS_FILE} 一致且产物齐全），无需同步。"
      exit 0
    fi
  else
    log "FORCE=1：跳过新鲜度检查。"
  fi

  download_files

  if [ "$SKIP_VERIFY" != "1" ]; then
    log "校验下载完整性 (sha256) ..."
    do_verify
  else
    log "SKIP_VERIFY=1：跳过 sha256 校验。"
  fi

  prepare_extra

  log "推送到 GitCode（reset release 后全新上传，上传段在本机执行）..."
  reset_release
  upload_build_files
  sync_legacy_files
  update_body

  if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
    echo "GitCode 同步存在失败（保留临时目录 $WORKDIR 便于排查）: ${FAILED_FILES[*]}" >&2
    exit 1
  fi

  log "上传成功 → 清理本地临时文件 ..."
  cleanup_local
  log "完成：GitCode 已同步 ${GITCODE_OWNER}/${GITCODE_REPO} ${GITCODE_TAG} 产物（Uploaded=${UPLOADED_COUNT} Skipped=${SKIPPED_COUNT}）。"
}
