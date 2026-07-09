# Proposal: parallel-local-tts

> 依据：既定后续清单第 1 项（用户拍板）。前置：`2026-07-09-move-sherpa-workers-to-utility-process` 已把 TTS worker 迁为独立进程——多进程并行的地基已就绪。

## Why

本地合成串行是批量配音的最大时间成本：zipvoice RTF ~0.44（200 行中文 ≈ 15 分钟）、kokoro 也在分钟级。合成是 CPU 推理（每 worker `numThreads=2`），多核机器大量算力闲置。worker 已是独立 utilityProcess，池化到 2–3 进程可获得近线性提速；代价是每路并行增加一份模型驻留内存（zipvoice 实测单进程峰值 ~1.5GB），必须默认关闭、用户显式选择并明示内存代价。

## What Changes

- **TTS runtime 进程池**：`SherpaTtsRuntime` 从单 worker 变为按需扩展的进程池（上限 3）——`synthesize` 选在途最少的 worker、不足目标池量则 spawn；`cancel` 按请求路由到所属 worker；单 worker 异常退出只 reject 该进程在途请求并从池移除（其余进程不受影响）；`shrinkTo(n)` 批量结束后回收多余空闲进程（避免 3 份模型常驻内存）；`dispose` 清池。
- **管线接入**：`DubbingConfig.localConcurrency?: 1|2|3`（默认 1）；本地引擎适配器 `concurrency = localConcurrency` 并在构建时 `setPoolSize`——批量调度直接复用既有云端并发 runner；批量结束 `shrinkTo(1)`。校准/复测语义并发安全（近似统计，顺序无关）。
- **工作台配置**：本地引擎选中时显示「并行合成」Select（1/2/3）+ 内存代价提示（每路约 0.5–1.5GB）；持久化记忆。
- **验证**：`smoke:utility` 增并行阶段（两进程同时合成，墙钟时间 < 串行和的 75%）；kokoro/zipvoice 真机批量对比。

**不做**：ASR worker 池化（转写是单文件流式任务，无并行需求）；自动按内存/核数调档（用户显式选择，避免低配机 OOM）。

## Capabilities

### Modified Capabilities

- `tts-local-engine`：「独立常驻 TTS worker」Requirement 升级为进程池语义（池上限/按需扩展/独立崩溃隔离/空闲回收）。
- `dubbing-workbench`：「全局配音配置」Requirement 增补本地并行合成选项。

## Impact

- **main**：`sherpaOnnx/ttsRuntime.ts`（池化重构，公共接口签名不变 + `setPoolSize`/`shrinkTo`）、`dubbing/dubbingProcessor.ts`（localConcurrency 透传与批量后收缩）。
- **types**：`types/dubbing.ts`（`localConcurrency`）。
- **renderer**：`DubbingConfigPanel`（并行 Select）、`useDubbing`（持久化）；i18n dubbing.json。
- **测试**：`smoke:utility` 并行阶段；既有单测/冒烟回归。
