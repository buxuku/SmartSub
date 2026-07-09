# Tasks: voice-clone-usability-pack

## 1. 火山剩余训练次数

- [x] 1.1 `volcengineVoiceCloneUtils.ts`：`extractVolcTrainingTimesLeft(payload)` 纯函数（`available_training_times`，缺省/负值 null）+ 4 项单测；`parseVolcCloneStatus`/`queryVolcCloneStatus` 返回值携带
- [x] 1.2 `types/voiceClone.ts` 增 `volcTrainingTimesLeft?`；create 轮询/volcRefreshStatus/volcRetrain 随状态落库；`ClonedVoicePanel` 元信息行「剩余训练次数 N」；i18n zh/en

## 2. 按字幕行选段（向导 Step2）

- [x] 2.1 `voiceClone:subtitleCues`（字幕行清单 IPC）；`absorbCuesFrom(cues, index, target, maxGapMs)` 纯函数落 `types/voiceClone.ts`（渲染层直取，比计划中的 referenceAudio.ts 更合理）——点选行向后吸收、间隙 >2s 断开、触硬上限即止、达推荐量收口、首尾 150ms 边距；5 项单测
- [x] 2.2 `CloneVoiceWizard` Step2：来源含字幕时质检卡下方渲染字幕行列表（max-h 滚动、时间戳 + 文本、与当前选区相交行高亮），点行 → absorb → setRange（质检/试听/Step3 文本预填全联动）；i18n

## 3. zipvoice 克隆质量档

- [x] 3.1 `types/dubbing.ts`：`DubbingConfig.cloneQuality?: 'standard' | 'high'`；`buildEngineAdapter(engine, opts)` 增 opts——zipvoice generationConfig `numSteps = high?8:4`；批量/单行（config 透传）与试听（IPC payload 增 cloneQuality）同源；试听样本合成沿用标准档
- [x] 3.2 `DubbingConfigPanel` 克隆引擎时显示「克隆质量」Select +「高质量约两倍耗时」提示；`useDubbing` persisted.cloneQuality（默认 standard）；i18n dubbing.json zh/en

## 4. 音色导入导出

- [x] 4.1 `types/voiceClone.ts`：`.svoice` 包结构（format/version/meta + refWav/sampleWav base64）+ `buildSvoicePackage`/`parseSvoicePackage`（format/version/name/engine/language 校验，zipvoice 必备参考对、火山必备槽位）；8 项单测（往返/五类拒绝）
- [x] 4.2 `voiceClone:export`（showSaveDialog `.svoice`）与 `voiceClone:import`（校验 → 新 id 落库落盘 → 失败清理残留；火山音色重绑本机豆包单例实例、状态按 ready 可刷新校正）；`ClonedVoicePanel` 导出按钮（toast 路径）+「我的音色」组尾导入入口（成功自动选中）；i18n

## 5. 本地降噪（zipvoice 兜底）

- [x] 5.1 gtcrn 模型随包：`extraResources/sherpa/denoise/gtcrn_simple.onnx`（~523KB 直接入库，与 silero_vad 同策略）；electron-builder 的 `sherpa/` 整目录块已覆盖零改动；`modelImport.ts` 增 `SHERPA_DENOISE_SUBPATH`/`resolveBundledDenoisePath`
- [x] 5.2 `sherpa-worker.js` 增 `denoise` 消息（模型常驻缓存 → readWave → OfflineSpeechDenoiser.run → writeWave）；`sherpaFunasrRuntime.denoise()` 接口
- [x] 5.3 `prepareCloneReference` 增 `opts.denoise`（24k 产物 → gtcrn（16k 输出）→ ffmpeg 重采样回 24k 就地替换 → 定稿复测以降噪后为准）；create IPC `localDenoise` 仅 zipvoice 消费；i18n
- [x] 5.5 处理开关前置到 Step2 质检卡旁（用户建议采纳——与质检结果同屏决策）：zipvoice「本地降噪」Switch + **「试听降噪」即时对比按钮**（`voiceClone:denoisePreview`：切选区 → gtcrn → 会话级临时 wav 播放 + 降噪后 SNR 展示，选区变化自动失效重算）；火山「服务端降噪 / 分离背景音」两个 Switch 同步前置；Step4 仅回显已选处理项
- [x] 5.4 冒烟 `scripts/voice-clone/denoise-smoke.mjs`：干净语音 + 白噪混合 → denoise 消息 → 质检管线 SNR 对比——15.4dB → 25.4dB（+10dB），15s 音频降噪耗时 368ms

## 6. 验收

- [x] 6.1 `test:voice-clone` 144 项全过（新增次数提取 4 / 行吸收 5 / svoice 包 8）；`test:dubbing` 137 / `check:i18n` / `tsc -p renderer` / `npm run build` 回归全过
- [x] 6.2 真机（用户，2026-07-09）：五件套 + 处理开关前置/试听降噪全部验证通过
