# Proposal: voice-clone-usability-pack

> 依据：`2026-07-09-add-voice-clone` / `add-volcengine-voice-clone` 归档后的既定后续清单（用户拍板按序推进）。本变更收纳同属 `voice-clone` 能力域的四项小型可用性增强 + 一项质量增强，不引入新架构。

## Why

声音克隆主体已落地并经真机验证，但日常使用还有几处「差一步」：火山槽位的剩余训练次数只能去控制台看（get_voice 响应里就有）；带字幕素材仍要靠听觉在波形上找段（字幕行本身就是现成的时间轴索引）；zipvoice 的 numSteps 质量档 PoC 已标定（4→8 RTF 0.44→0.91）但未暴露；克隆音色是用户资产却锁在单机（参考音频 + 文本即可完整迁移）；噪音素材只有火山有服务端降噪兜底，本地引擎缺对应手段（sherpa 官方 gtcrn 降噪模型仅 ~500KB，vendor JS 封装已随包）。

## What Changes

1. **火山面板剩余训练次数**：状态解析增提 `available_training_times`，create/刷新/重训时随 `trainStatus` 落库 `volcTrainingTimesLeft`；`ClonedVoicePanel` 元信息行展示「剩余训练次数 N」。
2. **按字幕行选段**（向导 Step2，来源含字幕时）：新增 `voiceClone:subtitleCues`（解析 srt 行清单）；选段器下方字幕行列表，点行 = 以该行为起点向后吸收相邻行（间隙 >2s 断开）至引擎推荐时长，选区/质检/文本预填全联动。
3. **zipvoice 克隆质量档**：工作台配置（克隆引擎时显示）「克隆质量」标准(numSteps 4)/高(8)；`DubbingConfig.cloneQuality` 全链路透传（批量/单行/试听），UI 注明高质量约两倍耗时。
4. **音色导入导出**（`.svoice` 单文件 JSON：meta + refText + 质检快照 + ref/sample wav base64）：面板「导出」+「我的音色」组尾「导入」；导入生成新 id 落库并落盘 wav；火山音色可导出（speakerId 随包，同账号跨机可用）。
5. **本地降噪（zipvoice 兜底）**：内置 sherpa gtcrn 降噪模型（~523KB 随包，形制 silero_vad）；ASR worker 增 `denoise` 消息（读 wav → OfflineSpeechDenoiser → 写 wav）；向导 Step4（zipvoice 分支）质检含噪音黄牌时出现「本地降噪」开关（默认关，注明会略损相似度），开启则 prepare 产物先降噪再落 ref.wav。

**不做**：ElevenLabs 克隆、麦克风录音、批量合成提速（清单后续批次）；服务端 demo_audio 试听（本地样本已覆盖，URL 1h 过期价值低）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `voice-clone`：管理面板 Requirement 增补剩余训练次数展示；创建向导 Requirement 增补字幕行选段与本地降噪开关 Scenario；新增「音色导入导出」Requirement。
- `tts-local-engine`：零样本克隆合成 Requirement 增补 numSteps 质量档合同。

## Impact

- **类型**：`types/voiceClone.ts`（`volcTrainingTimesLeft`、`.svoice` 包结构）、`types/dubbing.ts`（`cloneQuality`）。
- **main**：`volcengineVoiceCloneUtils/volcengineVoiceClone`（次数提取）、`ipcVoiceCloneHandlers`（subtitleCues/export/import/denoise 编排）、`dubbingProcessor`（numSteps 透传）、`sherpa-worker.js`（denoise 消息）、`sherpaFunasrRuntime`（denoise 接口）、`extraResources/sherpa/denoise/gtcrn.onnx`（随包新增）+ `electron-builder.yml`。
- **renderer**：`ClonedVoicePanel`（次数/导出）、`TtsServicesTab`（导入）、`CloneVoiceWizard`（字幕行列表/本地降噪开关）、`DubbingConfigPanel`（质量档）、`useDubbing`（cloneQuality 持久化）；i18n `voiceClone.json` / `dubbing.json`。
- **测试**：`test:voice-clone` 增次数提取/字幕行吸收纯函数/svoice 包构造与解析用例；冒烟按需扩展。
