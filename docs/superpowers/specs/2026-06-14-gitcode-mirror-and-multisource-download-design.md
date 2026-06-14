# GitCode 镜像同步修复 + 应用端多下载源设计

**日期**: 2026-06-14
**状态**: 已批准，待实现
**涉及仓库**:

- `whisper.cpp`（builder 分支，CI 同步脚本）— Part A
- `smartsub-py-engine`（main 分支，CI）— Part B
- `SmartSub`（本仓库，Electron 应用）— Part C

## 背景

存在两个相关问题：

1. **whisper.cpp 的 GitCode 镜像产物体积不对**。`builder.yml` 构建后把产物同步到 GitCode（`buxuku1/whisper.node` 的 `latest` Release）。最近优化了 Linux CUDA 包体积后，GitHub 已是小包，但 GitCode 仍是旧的大包。
2. **py-engine 还没有 GitCode 镜像**。用户在 GitCode 新建了 `buxuku1/smartsub-py-engine`，希望把 `smartsub-py-engine` 的构建产物也同步过去。
3. **应用端只支持 GitHub / ghproxy 两种源**。国内用户希望 CUDA 加速包与 py-engine 都能从 GitHub / githubproxy / GitCode 三种源下载。

## 证据（问题 1 的根因）

实测：

- GitHub `linux-cuda-1240-optimized.tar.gz`：`content-length = 160116448`（≈152MB，已优化）。
- GitCode 同名文件：通过 `https://gitcode.com/buxuku1/whisper.node/releases/download/latest/linux-cuda-1240-optimized.tar.gz` 下载，60s 仍在传输、已超过 556MB —— 是旧的未优化大包。
- GitCode `releases/tags/latest` 详情 JSON 中 `assets[]` **只有 `name` 和 `browser_download_url`，没有附件 id**。

`scripts/sync-gitcode-release.sh` 的覆盖逻辑 `upload_file ... replace=true` 依赖 `get_attach_id_by_name` 从 release 详情 `.assets` 取 id 后 `DELETE`。因为详情里没有 id，`attach_id` 恒为空，`delete_attachment` 直接 no-op，于是旧附件永远删不掉，新（小）包覆盖不上。这就是 GitCode 一直是大包的原因。

**额外发现（GitCode 下载 URL 格式）**：

- 正确的公开下载地址：`https://gitcode.com/{owner}/{repo}/releases/download/{tag}/{filename}`，会 302 跳到带签名的 `https://file-cdn.gitcode.com/...?auth_key=...`。
- API 详情里的 `browser_download_url` 用的是 `https://api.gitcode.com/...`，该地址对附件下载返回 404，**不可用于直链下载**。
- GitCode 有专门的附件列表接口 `GET /api/v5/repos/{owner}/{repo}/releases/{release_id}/attach_files`，返回**带 id** 的附件数组（与 Gitee v5 一致），可据此删除。

## 目标

- 修复 whisper.cpp → GitCode 同步，使每次构建能真正覆盖同名旧附件（体积与 GitHub 一致）。
- 为 py-engine 增加到 GitCode 的同步（与 whisper.cpp 同一套 token）。
- 应用端 CUDA 加速包与 py-engine 下载统一支持 github / ghproxy / gitcode 三源，并在所选源失败时按序自动回退。

## 非目标

- 不改动构建矩阵、产物命名、GitHub Release 流程本身。
- 不在 GitCode 维护多 tag（仅 `latest`）。
- 不把 token 写入代码或提交记录。
- 不重构 HuggingFace 模型下载源（`DownSource` HuggingFace/HfMirror 保持独立，仅与“二进制下载源”解耦）。
- 不引入 Qwen / 其它新引擎。

---

## Part A — 修复 whisper.cpp GitCode 同步（id 化删除）

**仓库/分支**: `whisper.cpp` `builder`
**文件**: `scripts/sync-gitcode-release.sh`

### 改动

1. **新增 `get_release_id`（兜底取 release id）**

   - 先用现有 `fetch_release_json`（`GET /releases/tags/latest`）取 `.id`。
   - 若为空，回退 `GET /releases` 列表，按 `.tag_name == latest` 匹配出 `.id`。
   - 删除附件与 PATCH 描述都依赖正确的 release id。

2. **新增 `fetch_attach_files(release_id)`**

   - 调 `GET /repos/{owner}/{repo}/releases/{release_id}/attach_files`。
   - 兼容返回包装：数组 / `{data:[...]}` / `{list:[...]}` / `{attach_files:[...]}`，统一输出 JSON 数组。
   - 非 200 时输出 `[]`（容错，不阻断）。

3. **新增 `attach_id_from_list(list_json, filename)`**

   - 从上面的列表里按 `.name == filename` 取 `(.id // .attach_id // .attach_file_id)`。

4. **改造 `upload_file`**

   - 取 `release_id=$(get_release_id)`；`attach_list=$(fetch_attach_files "$release_id")`。
   - `replace=false`（legacy）：存在性判断改用 `attach_list`（按 name 命中即视为已存在）兼容原 `.assets` 判断。
   - `replace=true`（build 产物）：`attach_id=$(attach_id_from_list ...)`；非空则 `delete_attachment "$release_id" "$attach_id"`，再上传。
   - PUT 后若返回 already-exists 且 `replace=true`：重新 `fetch_attach_files` 取 id → delete → 重试（替换原先从 `.assets` 取 id 的死路径）。

5. **保留** 现有流式上传（`curl -T`）、重试、超时、`continue-on-error` 等不变。

### 一次性补救

修复合入后，旧的大包仍在 GitCode（因为之前从未删成功）。补救二选一：

- 触发一次 `builder.yml`（或 `workflow_dispatch` 的 `sync_gitcode_only=true`），新逻辑会删旧传新；或
- 手动在 GitCode 删除一次旧的大包附件。

实现里**不写**一次性删除脚本，避免误删；以重新跑同步为准。

---

## Part B — py-engine 同步到 GitCode

**仓库/分支**: `smartsub-py-engine` `main`
**目标**: `buxuku1/smartsub-py-engine` 的 `latest` Release
**新增**: `scripts/sync-gitcode-release.sh`（自包含），改 `.github/workflows/release.yml`

### 同步脚本

自包含的精简版（不依赖 whisper.cpp 仓库），内置 Part A 的**正确 id 化删除**逻辑：

- 环境变量：`GITCODE_OWNER=buxuku1`、`GITCODE_REPO=smartsub-py-engine`、`GITCODE_TAG=latest`、`GITCODE_API_URL=https://api.gitcode.com/api/v5`、`GITCODE_TOKEN`（secret）、`ARTIFACTS_DIR`。
- 流程：`ensure_release`（无则建 tag+release）→ 对每个文件 `upload_file replace=true`（先 id 化删除再传）→ 可选 PATCH 描述。
- 同步文件清单（全部来自 `artifacts/`）：
  - `smartsub-engine-windows-x64.tar.gz`
  - `smartsub-engine-macos-arm64.tar.gz`
  - `smartsub-engine-macos-x64.tar.gz`
  - `smartsub-engine-linux-x64.tar.gz`
  - `manifest.json`
  - `checksums.sha256`
- 无 legacy 文件、无大文件 OOM 风险（最大 ~170MB），但仍用 `curl -T` 流式上传。

### CI Job

采用**方案 1**：让 `publish_latest` 把生成好的 `manifest.json`/`checksums.sha256` 作为 workflow artifact 上传，GitCode job 直接下载，保证两边内容完全一致。

1. `publish_latest` 末尾新增一步，把 `artifacts/manifest.json`、`artifacts/checksums.sha256` 用 `actions/upload-artifact` 上传（如 `name: py-engine-meta`）。
2. 新增 job：

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
      with: { path: artifacts, merge-multiple: true } # 含 4 个 tar.gz + manifest.json + checksums.sha256
    - name: Sync
      run: bash scripts/sync-gitcode-release.sh
      env:
        GITCODE_TOKEN: ${{ secrets.GITCODE_TOKEN }}
        ARTIFACTS_DIR: artifacts
```

> `download-artifact` 的 `merge-multiple: true` 会把 build job 的各平台 tar.gz 与 `publish_latest` 的 meta artifact 一起平铺到 `artifacts/`，脚本据固定清单上传。

### 密钥

py-engine 的 GitHub 仓库需配置 `GITCODE_TOKEN`（与 whisper.cpp 同一个 token）：
`gh secret set GITCODE_TOKEN --repo buxuku/smartsub-py-engine`（用户执行）。

---

## Part C — 应用端三源下载（addon + py-engine）

**仓库**: `SmartSub`
**决策**：

- 决策 1 = **A**：把 addon 与 py-engine 统一到一个“二进制下载源”设置（`github | ghproxy | gitcode`，复用 `addonDownloadSource`），与 HuggingFace 模型源解耦；引擎页提供独立选择器。
- 决策 2 = **加自动回退**：按所选源优先，失败时按规范顺序自动尝试另外两个源。

### 源与 URL

统一源类型：`type DownloadSource = 'github' | 'ghproxy' | 'gitcode'`（`types/addon.ts`）、`PyEngineDownloadSource` 同步加 `'gitcode'`（`types/engine.ts`）。

基址：

| 源      | addon 基址                                                           | py-engine 基址                                                             |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| github  | `https://github.com/buxuku/whisper.cpp/releases/download/latest/`    | `https://github.com/buxuku/smartsub-py-engine/releases/download/latest/`   |
| ghproxy | `https://ghfast.top/` + 上面的 github 地址                           | 同左                                                                       |
| gitcode | `https://gitcode.com/buxuku1/whisper.node/releases/download/latest/` | `https://gitcode.com/buxuku1/smartsub-py-engine/releases/download/latest/` |

> gitcode 用 `gitcode.com` 主机（非 `api.gitcode.com`）；现有 downloader 已处理 3xx 重定向，可直接跟随到 file-cdn。

### 回退顺序

`getSourceFallbackOrder(selected)`：

- 规范顺序 `DEFAULT_ORDER = ['gitcode', 'ghproxy', 'github']`（国内优先：先域内 gitcode，再代理 ghproxy，最后直连 github）。
- 返回 `[selected, ...DEFAULT_ORDER.filter(s => s !== selected)]`。
- 例：选 github → `[github, gitcode, ghproxy]`；选 ghproxy → `[ghproxy, gitcode, github]`；选 gitcode → `[gitcode, ghproxy, github]`。

回退触发与终止：

- **触发回退**：网络错误 / 连接超时 / HTTP ≥ 400 / 下载无数据超时 / 校验和不匹配（覆盖“镜像陈旧”场景）。
- **终止不回退**：用户取消（`Download cancelled`）、`protocol_unsupported`（协议区间不支持，换源也没用）。
- 回退发生时记录日志并在 UI 进度上提示“正在尝试备用源”。

### 主进程改动

- `types/addon.ts`：`DownloadSource` 加 `gitcode`。
- `types/engine.ts`：`PyEngineDownloadSource` 加 `gitcode`。
- `main/helpers/addonDownloader.ts`：`DOWNLOAD_SOURCES` 加 `gitcode`；新增 `getSourceFallbackOrder`；`download()` 支持按源序回退（断点续传仅在单源内有效，换源重新开始）。
- `main/helpers/addonVersions.ts`：`fetchRemoteVersions(useProxy:boolean)` 改为 `fetchRemoteVersions(source: DownloadSource)`，内部按回退顺序依次尝试拉 `addon-versions.json`；新增 gitcode 的 versions URL；更新 `getPackageDownloadSize` 等调用方。
- `main/helpers/pythonRuntime/paths.ts`：`getPyEngineDownloadUrl/ChecksumsUrl/ManifestUrl` 三个 builder 的 `source` 参数加 `gitcode` 分支。
- `main/helpers/pythonRuntime/downloader.ts`：`download()/checkUpdate()/fetchRemoteManifest()` 按回退顺序尝试；`protocol_unsupported` 不回退。

### 渲染层 / IPC / i18n

- `types`（renderer 侧）：`DownloadSource` / `PyEngineDownloadSource` 跟随主进程类型。
- `gpuDownloadUtils.ts`：`readPersistedDownloadSource` 接受 `gitcode`（非法值回落 `github`）。
- `CudaDownloadSheet.tsx`：选择器数组 `['github','ghproxy']` → `['github','ghproxy','gitcode']`，加 GitCode 文案。
- `GpuAccelerationCard.tsx`：失败自动切源逻辑改用 `getSourceFallbackOrder`（不再硬切 ghproxy）。
- `EnginesTab.tsx`：py-engine 下载源改为读取统一的 `addonDownloadSource`（决策 1=A），并提供与 CUDA 面板一致的三档选择器；移除 `resolvePyEngineDownloadSource` 对 HF 开关的依赖。
- i18n：`zh`/`en` 新增 `gitcode` 源名称与（可选）“正在尝试备用源”提示文案。

## 数据流

```
用户选择源 (github|ghproxy|gitcode, 存 addonDownloadSource)
        │
        ▼
getSourceFallbackOrder(selected) → [s1, s2, s3]
        │  依次尝试，遇可回退错误转下一个
        ▼
addon: getDownloadUrl(si, variant, type)         py-engine: getPyEngineDownloadUrl(si, tag)
        │                                                  │
        ▼                                                  ▼
下载 → 校验 sha256 → 解压安装                      下载 → 校验 → staging → 安全替换 → ping 自检
```

## 错误处理

| 场景                          | 行为                                |
| ----------------------------- | ----------------------------------- |
| 某源网络/HTTP/超时失败        | 记录日志，回退下一个源              |
| 校验和不匹配（镜像陈旧/损坏） | 回退下一个源；全部失败则报错        |
| `protocol_unsupported`        | 立即终止，提示升级 SmartSub，不回退 |
| 用户取消                      | 终止，不回退                        |
| 全部源失败                    | 抛出最后一个错误，UI 显示失败       |

## 测试计划

- **Part A/B（CI 脚本）**：本地 `bash -n` 语法检查 + `GITCODE_DRY_RUN=1` 跑通打印计划；上游各跑一次 workflow，核对 GitCode 与 GitHub 同名文件 `content-length` 一致、`checksums.sha256` 匹配。
- **Part C（应用）**：
  - 单元：`getSourceFallbackOrder` 三种输入的顺序；URL builder 三源输出正确。
  - 类型/构建：`npm run build` 通过；renderer `tsc` 通过。
  - 手动冒烟：三源各下载一次 addon 与 py-engine；断网首选源验证回退；选不存在的陈旧镜像验证校验和触发回退。

## 风险与缓解

| 风险                                      | 缓解                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| GitCode `attach_files` 返回结构与假设不同 | 脚本兼容多种包装；`fetch_attach_files` 失败回 `[]` 不阻断；先 `GITCODE_DRY_RUN` 验证 |
| get-by-tag 不返回 release id              | `get_release_id` 回退 get-all 匹配 tag                                               |
| 换源导致断点续传失效                      | 接受：换源重新下载（单源内仍续传）；日志标注                                         |
| gitcode CDN 签名链接过期/重定向多跳       | downloader 已跟随 3xx；签名 URL 即时生成，单次下载内有效                             |
| py-engine GitCode job 失败影响发布        | `continue-on-error: true`，不阻断 GitHub 发布                                        |

## 实现顺序（阶段）

- **Phase A**：whisper.cpp `sync-gitcode-release.sh` id 化删除修复（+ 本地 dry-run 验证）。
- **Phase B**：py-engine `sync-gitcode-release.sh` + `release.yml` job（+ manifest/checksums 作为 artifact）。
- **Phase C1**：应用端类型 + URL builder + 回退 helper（addon & py-engine 主进程）。
- **Phase C2**：`addon-versions.json`/manifest 拉取按源回退。
- **Phase C3**：渲染层选择器（CUDA 面板 + 引擎页统一源）+ i18n。
- **Phase C4**：构建 + 类型校验 + 冒烟。

> 上游两仓库的 `GITCODE_TOKEN` secret 配置由用户完成（同一 token）。
