---
title: MCP 与命令行
sidebar_position: 20
---

SmartSub 提供 **111 个 MCP 工具及对应 CLI 命令**，覆盖转写、翻译、校对、配音、合成、下载和配置资源管理。Codex、Claude Code 及其他支持 stdio MCP 的 AI 工具可直接调用。客户端使用桌面应用自带的 Electron/Node 运行时，安装后的用户无需另外安装 Node.js。

## 安装 CLI 和连接 AI 工具

先将应用安装到固定位置，再运行它附带的启动器。macOS 示例：

```sh
"/Applications/SmartSub.app/Contents/Resources/automation/smartsub" setup cli --install
"$HOME/.local/bin/smartsub" setup mcp --client codex --install
"$HOME/.local/bin/smartsub" setup mcp --client claude --install
```

`setup cli` 将启动器安装到用户的 `~/.local/bin`；Windows 对应 `%USERPROFILE%\.local\bin\smartsub.cmd`。将该目录加入 PATH 后可直接使用 `smartsub`。安装前会备份已有同名启动器。

其他平台的随包入口：

| 平台    | 启动器位置                                            |
| ------- | ----------------------------------------------------- |
| macOS   | `SmartSub.app/Contents/Resources/automation/smartsub` |
| Windows | 安装目录下 `resources\automation\smartsub.cmd`        |
| Linux   | 解包或安装目录下 `resources/automation/smartsub`      |

Linux AppImage 请先提取到固定目录（`--appimage-extract`），使用 `squashfs-root/resources/automation/smartsub`；不要把会随退出消失的临时挂载路径注册进 MCP。

`setup mcp` 默认只输出连接配置；加 `--install` 后调用对应 AI 客户端的 `mcp add`。它先备份客户端配置，再只注册 `smartsub` 服务。需要系统已经安装 `codex` 或 `claude` 命令。注册后重启 AI 会话以加载工具。若已有同名注册，先检查 `codex mcp get smartsub` / `claude mcp get smartsub`，再使用客户端的 `mcp remove smartsub` 后重新注册。

支持其他客户端：运行以下命令取得 `command`、`args`、`env`，放到该客户端的 `mcpServers.smartsub` 中：

```sh
smartsub setup mcp --client claude
```

这些配置通过 `ELECTRON_RUN_AS_NODE=1` 使用应用内置运行时启动 stdio MCP。MCP 握手无需打开窗口；第一次实际操作会连接已运行的桌面后台，或自动启动一个没有窗口的后台进程。同一配置目录只有一个写入进程，之后正常打开桌面应用会接入该进程。

## 第一次使用

```sh
smartsub doctor --json
smartsub models list --json
smartsub providers types --kind translation --json
smartsub providers list --json
smartsub system sample --json
smartsub operations list
smartsub operations describe media.trim
```

可以在 AI 对话中使用以下指令：

> 使用 SmartSub 检查已安装的本地模型，转写这个绝对路径下的音频。等待任务完成，读取前十条字幕，并将 SRT 转成 VTT。使用本地引擎，不调用付费服务。

完整字段结构见 [操作参考](./automation-reference.md)。工具名由命令名转换，例如 `media.extract-audio` 对应 `smartsub_media_extract_audio`。

## CLI 示例

所有路径均为 **SmartSub 所在机器的绝对路径**。复杂对象/数组使用 JSON；带空格或中文的路径按当前 shell 的规则加引号。

```sh
smartsub transcribe --files '["/absolute/audio.mp3"]' \
  --engine builtin --model tiny-q5_1 --source-language en --wait --json

smartsub translate --files '["/absolute/subtitles.srt"]' \
  --provider-id my-translator --target-language zh --wait --json

smartsub media extract-audio --file-path /absolute/video.mp4 \
  --config '{"format":"wav","wavPreset":"asr_16k_mono"}' --wait --json

smartsub compose run --video-path /absolute/video.mp4 \
  --subtitle-path /absolute/subtitles.srt --output-path /absolute/result.mkv \
  --config '{"outputMode":"softmux"}' --wait --json

smartsub subtitles read --file-path /absolute/subtitles.srt --offset 0 --limit 10
smartsub subtitles convert --file-path /absolute/subtitles.srt --target-format vtt --wait
smartsub tasks list --limit 20
smartsub tasks get --id TASK_ID
smartsub tasks cancel --id TASK_ID
```

`--input-json /absolute/input.json` 可提供完整输入；`--input-json -` 从标准输入读取，适合密钥、复杂流水线和批处理。命令行显式字段会覆盖 JSON 中同名字段。输出默认是 JSON，`--json` 输出紧凑 JSON，日志/错误只进入 stderr。

### 流水线

用 `pipeline.run` 一次提交转写/翻译、可选配音和视频合成。输入 JSON 示例：

```json
{
  "files": ["/absolute/video.mp4"],
  "taskType": "generateOnly",
  "engine": "builtin",
  "model": "tiny-q5_1",
  "sourceLanguage": "en",
  "config": {
    "compose": { "subtitle": "soft" },
    "gates": { "subtitle": "auto", "dubbing": "auto" }
  },
  "requestId": "my-video-job-001"
}
```

```sh
smartsub pipeline run --input-json /absolute/pipeline.json --wait
```

新提交的自动化流水线默认自动放行。显式设置 `manual` 时，任务停在 `review`；检查/编辑后调用 `pipeline.release`，原任务 ID 继续更新。配音工作台拥有会话或存在未确认草稿时返回 `SESSION_BUSY` / `UNSAVED_EDITS`，先在工作台保存并关闭编辑器。

### 服务商和资源

`providers.types` 返回各类型的字段、必填项和能力。用 `providers.save` 写入 `{kind, provider}`，`provider.id` 唯一标识实例；更新时省略的凭据会保留，读取时凭据脱敏。密钥优先经 JSON 文件或 stdin 传入，避免出现在 shell 历史中。`providers.test` 会发出真实请求，是否收费取决于所选服务商。

`models.list/install/import/delete` 管理本地模型；`engines.*` 管理 faster-whisper 运行时；`downloads.*` 管理下载器、批次及 Cookie；`glossaries.*`、`recipes.*`、`voices.*` 管理词库、配方和克隆音色。导入/导出必须给显式文件路径，不会弹出文件选择框。

## 任务、恢复与文件保护

- 耗时操作立即返回持久化任务 ID，状态有 `queued`、`running`、`paused`、`review`、`cancelling`、`completed`、`failed`、`cancelled`、`interrupted`。使用 `tasks.wait` 最长等待 25 秒，可反复调用；等待超时不取消任务。
- `--wait` 默认最多等待一小时，可用 `--timeout` 指定毫秒。断开 MCP 或关闭 CLI 不影响已接受的后台任务。无窗口、无活跃任务且五分钟没有请求后后台自动退出。
- `requestId` 用于提交去重：相同 ID 和相同输入返回原任务；不同输入报 `REQUEST_CONFLICT`。连接中断后先查询任务，避免重复产生输出。
- 后台重启后运行中的收据标为 `interrupted`，不自动重做。流水线用 `tasks.retry`；其他操作检查现有产物后重新提交。已完成收据和去重信息仍保留。
- `tasks.get/list/wait` 可读取桌面任务；暂停/继续/重试针对流水线，下载另有 `downloads.resume/retry`。`actions` 指示当前支持的控制。不能中断的操作返回 `CANCEL_UNSUPPORTED`。
- 流水线默认输出到当前配置目录的 `automation/outputs/<任务ID>`，每个输入独立子目录。显式目标已存在时拒绝覆盖；工具箱可能按原有规则生成新的唯一文件名。
- `subtitles.read` 返回 SHA-256 `version`。原地写入需 `overwrite=true` 和 `expectedVersion`，并保留 `.bak`；版本过期、其他自动化写入或桌面未保存草稿会阻止修改。`proofread.save` 更新校对数据并重新渲染其关联字幕。
- `tasks.delete` 删除任务记录；关联的配音会话按桌面原有删除规则清理，不删除源媒体。导出的独立文件需自行管理。

退出码：`0` 成功，`2` 参数错误，`3` 业务失败/任务中断，`4` 后台连接失败，`5` CLI 等待超时，`130` 任务取消。MCP 执行错误使用 `isError=true`；异步执行失败记录在任务的 `error` 中。

## 配置目录和排错

默认连接桌面应用的用户配置目录；开发启动器默认使用开发目录。用 `--data-dir /absolute/profile` 或 `SMARTSUB_DATA_DIR` 隔离配置、凭据、任务和输出。MCP 注册命令也接受 `--data-dir`。

- `BACKEND_UNAVAILABLE`：查看 `<profile>/automation/backend.log`，确认应用路径存在，Linux 有图形会话或 Xvfb。此后台依赖 Electron，尚非纯服务器守护程序。
- CLI 无法连本机后台：检查 AI shell 沙箱是否允许 loopback 网络。Codex MCP 由客户端托管；从其 shell 再运行 CLI 时也需要网络权限。验收脚本仅在自己的隔离会话中设置 `sandbox_workspace_write.network_access=true`。
- AI 客户端拒绝写操作：按客户端策略批准对应工具；无人值守运行需设置具体工具的许可。验收脚本仅允许其中六项测试工具，不会修改全局审批策略。
- `MODEL_UNAVAILABLE` / `ENGINE_UNAVAILABLE`：先安装对应模型/运行时，再提交任务。模型下载、在线视频下载和云服务依赖网络。
- 配置路径变化：移动应用后重新运行 `setup cli` 和 `setup mcp`。
- 日志：`system.logs` 读取脱敏日志。`automation/backend.log` 包含原有服务/原生库日志，分享前自行检查敏感信息。

外部 MCP 仅支持本机 stdio。内部连接是随机端口的 loopback HTTP，使用当前用户配置目录内的随机令牌，拒绝浏览器 Origin；它不是远程 HTTP MCP。没有暴露任意 IPC、shell 执行、UI 点击、麦克风录音或浏览器 Cookie 抓取能力。

## 开发与验证

```sh
npm ci
npm run build:automation:dev
npm run smartsub -- system info --json
npm run test:automation
npm run build
npm run test:automation:desktop
npm run docs:automation
```

生产构建在 Nextron 构建后生成客户端（Nextron 会清理输出目录），Electron Builder 将运行时入口复制到 `resources/automation`。现有桌面 IPC 与自动化共享业务处理函数，任务/配音会话仍遵守桌面原有锁和持久化规则。

`test:automation` 使用临时配置目录，真实 FFmpeg 和本地 HTTP fixture 测试 ASR/TTS/AI 请求，不需要服务商密钥或模型下载。`test:automation:ai` 需要已登录的 Codex/Claude Code，以及 `SMARTSUB_TEST_PROFILE` 中安装好的 `tiny-q5_1` 模型；运行真实 AI 会话并校验 SRT/VTT、任务收据和 CLI 结果。AI 客户端自身可能消耗其既有账户额度。验证记录见仓库 `docs/automation-validation.md`。
