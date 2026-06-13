# B17 whisper addon native abort 设计与决策记录

> 日期：2026-06-13 · 分支 `feat/resource-hub`
> addon 来源：[buxuku/whisper.cpp latest release](https://github.com/buxuku/whisper.cpp/releases/tag/latest)（20260613 构建，含 AbortSignal）

## 决策 #1：AbortSignal 接入点

**采用方案**：`generateSubtitleWithBuiltinWhisper` 的 `whisperParams` 传入 `getTaskContext()?.signal`——与 B1 任务 `AbortController` 同源，取消任务时 `runtime.controller.abort()` 自动传导至 native whisper。

**暂停语义**：维持 B1 设计——暂停不 abort 当前转写，仅停止派发新文件。

## 决策 #2：abort 错误分流

**采用方案**：

- 新增 `isWhisperAbortError()`（throw 路径：AbortError / message 含 abort|cancelled）
- 新增 `isWhisperCancelledResult()`（**resolve 路径**：addon 返回 `{ cancelled: true, transcription: [] }`，不 throw）
- 两条路径均抛 `TaskCancelledError`，不走 `onError`，删部分 srt，阶段回退为空

**备选**：保留部分转写结果——与「取消=可重跑」语义冲突，弃。

## 决策 #3：mac ARM 内置 addon 更新

**采用方案**：仓库 `extraResources/addons/addon.node` + `addon.coreml.node` 替换为 latest release 的 `addon-macos-arm64.node` / `addon-macos-arm64-coreml.node`。其它平台仍由 CI release workflow 从同一 release 下载。

## 验收标准

1. 转写中点取消，数秒内 spinner 停止（whisper CPU/GPU 占用回落）；
2. 取消文件不显示失败，状态回退为待处理；
3. 取消后立即重跑同文件结果正确；
4. 三项门禁全绿。
