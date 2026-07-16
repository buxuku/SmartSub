# Proposal: add-clone-mic-recording

> 依据：既定后续清单第 4 项（用户拍板「后续方向按步骤依次实现」）。

## Why

现有创建向导只接受「已有音视频文件」。没有现成素材的用户（想克隆自己声音的主播/配音初学者）需要先用第三方工具录音再导入，链路断裂。向导内直接录音把「从零创建我的音色」变成一站式：录 30–60 秒朗读 → 自动质检选段 → 克隆，且录音环境可控（安静、单人、无背景乐），天然贴合素材要求。

## What Changes

- **Step1 第三入口「用麦克风录制”**：与拖放/最近任务并列。点击进入录音面板：
  - `getUserMedia + MediaRecorder`（webm/opus）渲染进程采集；`AnalyserNode` 实时电平条（可视化「正在收音」）+ 计时器；
  - **朗读脚本引导**：按界面语言内置一段中/英朗读文本（覆盖常见音素、时长充足），用户照读免打稿；目标时长提示按引擎档位（zipvoice ≥15s / 火山 ≥30s / EL ≥60s，给选段留余量）；
  - 停止后可试听、重录，确认后进入既有分析链路（`voiceClone:analyze`）——录音与文件素材共用全部后续步骤（QA/选段/文本/创建）。
- **落盘 IPC** `voiceClone:saveRecording`：ArrayBuffer → 临时目录 `voice-clone/rec-<ts>.webm`（ffmpeg 链路可直接解码 webm/opus），返回路径作为 sourcePath；素材名展示为「麦克风录音」。
- **麦克风权限**：
  - macOS 打包：`electron-builder.yml` `mac.extendInfo.NSMicrophoneUsageDescription`（缺失时 TCC 直接拒绝且无提示）；
  - 主进程 `systemPreferences.askForMediaAccess('microphone')`（darwin）前置请求；拒绝时 UI 给「系统设置 → 隐私与安全性 → 麦克风」指引文案。
- **录音时长上限** 5 分钟自动停止（防误留后台录音；分析链路对长素材本就有自动选段兜底）。

**不做**：输入设备选择器（走系统默认输入）；本地录音降噪（已有 zipvoice 本地降噪/云端开关兜底）；录音波形实时滚动图（电平条足够）。

## Capabilities

### Modified Capabilities

- `voice-clone`：新增「麦克风录音素材入口」Requirement（录音采集/落盘/权限/时长护栏语义）。

## Impact

- **main**：`ipcVoiceCloneHandlers.ts`（saveRecording + requestMicAccess）；`electron-builder.yml`（mac extendInfo）。
- **renderer**：`CloneVoiceWizard` Step1 录音面板（内聚小组件 `MicRecorder`）；i18n（zh/en）。
- **测试**：录音落盘 IPC 与权限分支逻辑轻量（以真机自测为主）；朗读脚本为静态文案不需单测。
