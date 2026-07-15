# Tasks: parallel-local-tts

- [x] 1.1 `sherpaOnnx/ttsRuntime.ts` 进程池：WorkerHandle（proc + 在途计数 + alive）、`setPoolSize(1..3)`、synthesize 选最闲 worker/按需 spawn、cancel 路由到所属进程、单进程 exit 只 reject own 在途并移池（failOwn）、`shrinkTo(n)` 回收空闲、dispose 清池；公共接口签名不变
- [x] 1.2 `types/dubbing.ts` `localConcurrency?: number`；`dubbingProcessor` 本地适配器 concurrency = clamp(localConcurrency,1,3) + setPoolSize（批量调度复用既有云端并发 runner）；批量 finally shrinkTo(1)；previewVoice/单行沿用 1
- [x] 1.3 `DubbingConfigPanel` 本地引擎「并行合成」Select（1/2/3，>1 时内存提示：普通 ~0.5GB/克隆 ~1.5GB 每路）；`useDubbing` 持久化 + config 透传；i18n zh/en
- [x] 1.4 `smoke:utility` 增并行阶段：**实测串行 9199ms vs 双进程并行 4421ms（48%，近线性 2x）**，断言 <75% 通过
- [ ] 1.5 回归：test:voice-clone 144 / test:dubbing 137 / check:i18n / build 全过；真机批量对比（用户）
