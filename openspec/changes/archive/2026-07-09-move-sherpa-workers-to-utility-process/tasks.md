# Tasks: move-sherpa-workers-to-utility-process

## 1. worker 通信适配

- [x] 1.1 `extraResources/sherpa/worker/tts-worker.js` 与 `sherpa-worker.js`：顶部通道适配层——`process.parentPort`（utilityProcess，message 事件取 `.data`）优先，回落 `worker_threads.parentPort`；全部 `parentPort.postMessage/on` 改走适配层（channel.post / channel.onMessage），协议本体零改动

## 2. runtime 迁移

- [x] 2.1 `main/helpers/sherpaOnnx/ttsRuntime.ts`：`utilityProcess.fork`（env 注入不变、serviceName `smartsub-tts-worker`、stdio pipe → stderr 进 logMessage warning 级）；`terminate()` → `kill()`；exit 非零 failAll 文案「本地 TTS 引擎异常退出（code N），已自动重置，请重试」
- [x] 2.2 `main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts`：同形迁移（serviceName `smartsub-asr-worker`）
- [x] 2.3 公共接口签名不变，调用方零改动：`tsc --noEmit` sherpaOnnx 目录零错误；`test:voice-clone` 126 / `test:dubbing` 137 全过

## 3. 验证

- [x] 3.1 `scripts/voice-clone/utility-smoke-main.js` + `npm run smoke:utility`：三阶段全过——①utilityProcess 合成 OK（stderr 采集同时验证：sherpa lexicon 警告被捕获）；②在途合成时 kill 子进程，主进程存活；③重新 fork 合成成功（自动重建语义）
- [x] 3.2 回归：worker_threads 兼容路径全过——`poc:zipvoice`（RTF 0.44 与迁移前一致）/ `smoke:voice-clone` / `speed-curve`（zh 4.1 字/s 基准复现）；`test:voice-clone` 126 / `test:dubbing` 137 / `npm run build` 全过
- [x] 3.3 真机（用户，2026-07-09）：dev 应用内克隆合成与本地转写均正常运行，无回归
