# MCP / CLI 验证记录

2026-09-23，macOS Apple Silicon，SmartSub 3.8.0，Electron 30.5.1。此记录说明实际运行范围，不代表 111 个操作的每种引擎、服务商、平台组合均已验收。

## 实际 AI 客户端

| 客户端              | 验证内容                                                                                                 | 结果                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Codex CLI 0.156.1   | MCP 获取样例 → builtin / tiny-q5_1 本地转写 → 等待 → 读取 SRT → 转 VTT → 等待并读取 → shell CLI 媒体探测 | 通过，收据与 SRT/VTT 文件已核验        |
| Claude Code 2.1.260 | 相同流程，最后使用安装于固定目录的 `.app` 内置运行时                                                     | 通过，无工具权限拒绝，收据与产物已核验 |

两个客户端均保留其原有 AI 模型配置。媒体转写使用本地 whisper.cpp / Metal；未调用付费 ASR、翻译或 TTS 服务。Codex 验收在临时会话中允许六项测试工具，并启用 workspace-write sandbox 的网络访问，以便 shell CLI 连接本机后台；没有修改全局审批设置。

样例生成 5 条字幕，第一条：`Welcome to Smart Sub. This app turns`。CLI 探测为 MP3、10.33 秒、有音轨。通过的任务：

- Codex：`de31e6da-0e0b-4d55-8c2a-59e0354791e6`
- Claude Code（安装版）：`cf14af24-ed6e-457a-9075-8dd6f3a4cd52`

原始日志和验证结果留在本机忽略目录 `node_modules/.cache/automation-ai/` 与 `node_modules/.cache/automation-ai-installed/`，分别包含客户端输出、stderr、MCP 配置和 `*.verified.json`。不将可能包含本机路径/客户端信息的完整日志提交到仓库。

## 程序化集成

`npm run test:automation` 在源码生产构建、macOS 打包应用和固定安装应用上通过，使用临时 profile 和真实 MCP SDK 客户端：

- MCP initialize、111 个唯一工具及 JSON Schema、实际 tools/call。
- 冷启动不创建 BrowserWindow；本机令牌校验与浏览器 Origin 拒绝。
- 中文/空格文件名，字幕分页，新文件覆盖拒绝、版本冲突、备份与转换。
- 相同 requestId 去重、冲突输入拒绝、客户端断开重连、后台重启恢复。
- 原生 FFmpeg 生成测试视频、探测、音频提取、软字幕封装。
- 写入服务商凭据、脱敏读取及省略密钥的补丁保留。
- 无渲染器配音会话创建、带基础文本的行编辑和冲突拒绝。
- 本机 HTTP fixture 经真实 OpenAI-compatible 请求链运行 ASR、AI 润色、TTS、配音批量合成和 WAV 导出。
- TTS 请求取消、人工字幕检查点放行后原任务继续完成、校对数据版本冲突。
- CLI stdout 为可解析 JSON，MCP 参数错误使用 isError，运行中收据重启后标为 interrupted。

`npm run test:automation:desktop` 在源码生产版及 macOS 打包版通过：无窗口启动后第二实例打开桌面，原后台继续运行；renderer IPC 与自动化共享设置/词库；原生对话框收到真实 BrowserWindow；页面无 pageerror，截图已人工查看。

## 构建与回归

- `npm run typecheck`：renderer、main、automation 均通过。
- `npm run build`：生产前后端和独立 CLI/MCP bundle 通过。
- Electron Builder `--dir --mac --arm64 --publish never`：通过，包含 `Contents/Resources/automation`。
- 受影响回归通过：task-submission、work-item-durability、dubbing-ownership、compose-queue、proofread-reliability；此前本次实现亦运行通过 toolbox、download-pipeline、compose-output。
- `git diff --check`：通过。
- CLI 安装至用户 `~/.local/bin/smartsub`；MCP 注册至 Codex 和 Claude Code 用户配置，配置写入前已备份。默认 profile 的 `smartsub doctor --json` 成功，模型 tiny-q5_1 / tiny-q8_0 可见。Claude Code `mcp get smartsub` 显示 Connected。

## 验证边界

macOS 产物为本机构建，未签名、公证或发布。Windows/Linux 启动器与构建配置已实现，新增 `.github/workflows/automation.yml` 三平台集成矩阵，尚未在本次本机环境实跑远端 CI。Linux 后台仍依赖 Electron 图形环境，CI 使用 Xvfb。

未逐一联网验证所有服务商、下载站点、模型下载源及声音克隆引擎；这些接口复用现有业务实现，依赖对应配置、模型、网络或服务商许可。Fixture 验证代表请求与调度链路，不代表外部供应商服务可用性。运行时安装使用进度查询，部分原有操作不支持取消；工具调用会明确返回相应限制。

## Review 修复回归

同日修复 9 项 review 问题后重新运行通过：

- `test:automation:regressions`：代理 URL 凭据及诊断脱敏、正文/路径保真、源字幕优化模式、配音部分失败保留结果、共享取消信号、重试回执去重、最新历史顺序、媒体/模型/合成进度按 ID 路由及成功/失败/取消后的监听器清理。使用虚拟时间推进超过六分钟，确认运行时下载、解压、验证及安装期间不会被空闲回收，结束后可正常退出。
- `test:automation`：真实 MCP 读取和重新写入包含 `password:` / `Bearer` 的字幕保持内容不变；设置返回隐藏 URL 用户名密码；本地 TTS HTTP 400 fixture 导致任务 `failed`，保留 `failedIndexes`，等待中的 CLI 返回退出码 3；源字幕优化发送 `Do not translate` 提示；真实 FFmpeg 任务具有进度。
- `test:automation:desktop`：通过 renderer 的真实 `cancelTask` IPC 取消自动化流水线后状态为 `cancelled`；重试运行期间重复 requestId 返回同一回执。
- 类型检查、生产构建和 task-submission 回归通过。测试均使用临时配置和本地 fixture，无新增云服务调用。

修复后的 macOS `.app` 也已重新通过上述 MCP/CLI 和桌面集成测试，并替换本机 `~/Applications/SmartSub.app`；旧应用保留为同目录备份。默认配置的 `smartsub doctor` 复核成功，原有 MCP 注册继续指向相同安装路径。
