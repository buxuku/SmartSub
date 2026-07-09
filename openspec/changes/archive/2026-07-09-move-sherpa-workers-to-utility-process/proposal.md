# Proposal: move-sherpa-workers-to-utility-process

> 依据：`2026-07-09-add-voice-clone` 真机事故——zipvoice 克隆合成触发 onnxruntime 大块分配 SIGTRAP，`worker_threads` 与主进程同进程，**直接带崩整个应用**（用户实测崩溃报告 Thread 16 `BFCArena::Extend → PartitionAlloc CHECK`）。当次以文本切块 + 参考上限收紧化解了触发条件，但「native 推理崩溃 = 应用崩溃」的结构性风险仍在（ASR worker 同理）。

## Why

sherpa-onnx 的 TTS/ASR worker 目前跑在 `worker_threads`：线程与 Electron 主进程共享地址空间与内存分配器（PartitionAlloc），onnxruntime/native 层的任何 abort（超大分配、断言、段错误）都会击杀主进程，用户丢失全部工作状态。Electron 的 `utilityProcess` 正是为此设计——独立进程跑 Node + native addon，崩溃只死子进程，主进程收 `exit` 事件后按既有「worker 置空 → 下次请求自动重建」恢复语义无缝续命。`tts-local-engine` spec 原文即写「独立常驻**子进程**」，本变更使实现真正符合 spec 措辞。

## What Changes

- **worker 通信双运行时适配**（`tts-worker.js` / `sherpa-worker.js` 顶部适配层）：Electron utilityProcess 下走 `process.parentPort`（message 事件为 MessageEvent，取 `.data`）；纯 node 下回落 `worker_threads.parentPort`（PoC/冒烟脚本零改动继续可用）。消息协议本体不变。
- **runtime 迁移**（`ttsRuntime.ts` / `sherpaFunasrRuntime.ts`）：`new Worker(...)` → `utilityProcess.fork(...)`（env 注入不变、`serviceName` 标识、`stdio: 'pipe'` 收集 stderr 进应用日志——native 崩溃前的输出是关键诊断线索）；`terminate()` → `kill()`；异常退出沿用既有 `failAll + 置空重建` 恢复语义。
- **崩溃隔离语义**：worker 进程 abort 时主进程不受影响，在途请求以可读错误 reject（「本地引擎异常退出，已自动重启，请重试该行」），下次调用自动重建 worker。
- **Electron 级冒烟**：`scripts/voice-clone/utility-smoke-main.js`（`electron` 直接跑的无窗口 app）——fork TTS worker → kokoro 合成一句校验 done → 二阶段故意杀死 worker 验证主进程存活与错误 reject。

**不做**：ASR/TTS worker 合并进程（保留崩溃互不影响的双进程）；worker 池/多实例并行（后续性能项）；whisper.cpp addon 迁移（不同加载体系）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tts-local-engine`：「独立常驻 TTS worker」Requirement 升级为真独立进程（utilityProcess）语义——native 崩溃不影响主进程、stderr 进日志、自动重建 Scenario。

## Impact

- **worker 侧**（extraResources，不经 webpack）：`tts-worker.js` / `sherpa-worker.js` 通信适配层（协议与推理逻辑零改动）。
- **main 侧**：`main/helpers/sherpaOnnx/ttsRuntime.ts`、`sherpaFunasrRuntime.ts`（Worker → UtilityProcess，公共接口不变，调用方零改动）。
- **测试**：既有 PoC/冒烟脚本（worker_threads 路径）全量回归；新增 electron utilityProcess 冒烟。
- **风险**：utilityProcess 消息通道为结构化克隆（现协议全为路径/数字/字符串，无跨线程 TypedArray 依赖）；dev 与打包路径均取 extraResources 绝对路径，不受影响。
