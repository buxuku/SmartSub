## 1. 语音边界源抽象 + 能量兜底

- [x] 1.1 新建 `main/helpers/speechBoundary.ts`：定义 `SpeechSegment = { start: number; end: number }` 与 `getSpeechSegments(audioFile): Promise<SpeechSegment[]>`（不可用返回空数组）
- [x] 1.2 实现能量兜底分支：复用 PR #341 `analyzePcm16WavEnergy`，把连续「有声帧」合并为 `SpeechSegment[]`（已在 `subtitleTiming.ts` 导出 `analyzePcm16WavEnergy` / `AudioEnergy`；含短静音桥接 0.2s + 碎片过滤 0.12s）
- [x] 1.3 边界源链：Silero（D3）→ 能量 → 空；任一步抛错都吞掉并降级，不影响转写

## 2. sherpa「只跑 VAD」入口

- [x] 2.1 `extraResources/sherpa/worker/sherpa-worker.js` 增 `detectSpeech` 请求类型：仅建 `sherpa.Vad`（不建 OfflineRecognizer），读 WAV → 滑窗 `acceptWaveform` → 收集 `vad.front()` 段 → 转秒返回 `[{start,end}]`
- [x] 2.2 `main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts` 增 `detectSpeech(audioFile, vadModel, params)` 运行时封装（复用常驻 worker + pending 机制），`vadModel` 用 `resolveBundledVadPath()` 的内置 `silero_vad.onnx`
- [x] 2.3 主进程侧用 `isSherpaLibInstalled()` 把关：未安装/加载失败即判 Silero 不可用，交由 1.3 回退能量法
- [x] 2.4 确认既有 VAD+ASR 路径（funasr/qwen/fireRed）不受影响（仅新增 `detectSpeech` 分支 + 独立 `vadOnly` 缓存，不改 transcribe 既有逻辑）

## 3. 分段与时间轴贴齐

- [x] 3.1 新建 `main/helpers/subtitleSegmentation.ts` 的 `retimeTokensToSpeech(tokens, segments)`：把每个 token 收敛到与「重叠最大的语音段」的交集首/末边界；无交集原样保留
- [x] 3.2 同文件实现 `groupTokenCues`（停顿/句末标点/长度聚合，纯标点不单切，非 token 级输入安全降级）
- [x] 3.3 单元可测：模块零运行时依赖（自带结构等价 `SpeechSegment`，不 import speechBoundary/electron）；`retimeTokensToSpeech` / `groupTokenCues` 接受注入的假 `SpeechSegment[]`

## 4. builtin 管道接线

- [x] 4.1 `builtinEngine.ts`：`max_len:0→1`
- [x] 4.2 接线管道：`getSpeechSegments(tempAudioFile)` 一次 → `retimeTokensToSpeech` → `groupTokenCues` → `trimSubtitleTrailingSilence`（兜底）→ `formatSrtContent`
- [~] 4.3 三级降级验证：Silero（真机命中为主）+ 能量（真机等价 24 段）已验证；非 PCM16 退回连续时间轴仍为代码层（getSpeechSegments 空数组 → retime 原样返回；trim 自带 fs/PCM16 兜底），未单独真机触发

## 5. 验证

- [x] 5.1 纯逻辑行为测试（test:engines）：retime 把「被填满」的 token 收回真实有声段、停顿重现；group 按 gap>0.5s / 句末标点切分、纯标点不单切（合成 WAV 端到端见 5.4）
- [x] 5.2 Silero 与能量两条边界源对同一素材的段边界对比：真机 `ASR ZH Longgap` 两源各 24 段、边界误差 ~0.1s（Silero 命中为主，能量兜底结果等价）
- [x] 5.3 `yarn test:engines` 全过（147 passed, 0 failed）；改动文件无 lint 错误
- [x] 5.4 真机回归（`ASR ZH Longgap`，base / base-q8_0）：新管道均 **14 条 / 4 gap**（旧 `max_len=0` 为 9 条 / 0 gap），普通与量化结果一致、CJK 不坍缩；对比 faster-whisper 参考（20 条 / 5 gap）边界误差 ~0.1–0.2s，所缺 1 个 gap 即 D8 修复点。真机脚本 `scripts/test-builtin-longgap.ts`（不提交）
- [ ] 5.5 回归既有引擎：faster-whisper/funasr/qwen/fireRed 行为与 `main` 一致（裁尾不变）

## 6. 后续可做（Next TODO）

- [ ] 6.1 边界源与阈值（来源选择 / VAD 阈值 / gap 0.5s / 时长 8s / 宽度 40）接入设置项 UI
- [x] 6.2 连续长语流按标点优先软切；前导标点归属优化（避免 cue 以「，」开头）→ 见 §8
- [ ] 6.3 `silero_vad.onnx` 完整性校验（损坏自动回退能量法）
- [ ] 6.4 多样音频回归：背景音乐/噪声、多语种（英/日）、超长音频性能基准

## 7. cue 跨停顿修复（D8，A 为主 + B 兜底）

- [x] 7.1 A：`retimeTokensToSpeech` 无交集分支——非空内容 token 前向贴齐到「其后最近语音段」start（原时长截到段内）；其后无段则回收前段末点；空 / 空白 / 纯标点 token 原样保留（护栏，纯标点随相邻 cue 收尾，避免孤立标点条）。新增 `snapContentTokenToSegment` 助手
- [x] 7.2 B：新增纯函数 `clampCuesToSegments(cues, segments)`（起止收进真正重叠的语音段；无重叠 cue 原样）；`builtinEngine` 在 `groupTokenCues` 后、`trimSubtitleTrailingSilence` 前接入
- [x] 7.3 单测（test:engines，155 passed）：内容 token 串填静音 → retime 前向贴齐、group 在停顿处切分；空 / 纯标点 token 落静音 → 原样；`clampCuesToSegments` 收敛跨静音 cue、多段 cue 保内界、无重叠 cue / 空段原样
- [x] 7.4 真机复测同素材（`ASR ZH Longgap`，base / base-q8_0 一致）：cue5「請記錄以下信息」起点由 21.5s → **25.35s**（21.31→25.35 停顿复现）；gap 由 4 → **6**（全部落在 Silero 真实静音：10.97/21.31/36.96/49.92/62.04/73.12），无跨停顿、无孤立标点条。仅 A 即得 6 gap，B 作兜底（pre/post-clamp 一致）。粒度 14 条仍较 faster-whisper 20 条粗，属 §6.2

## 8. 标点优先软切 + 前导标点归属（§6.2，见 design D9）

- [x] 8.1 软切：`groupTokenCues` 内当 cue 显示宽度达 `softMaxWidth`（默认 10）**或**时长达 `softMaxDuration`（默认 2.5s）后，遇停顿性标点 `SOFT_PUNCT = /[，,；;]/` 即收尾（优先于硬宽度/时长上限）。**排除顿号「、」与冒号「：」**（护栏：号码 / 枚举内部不被切碎）
- [x] 8.2 前导标点归属：开新 cue 时若首 token 为纯标点（`PUNCT_ONLY`）→ 贴回上一条 cue 末尾、不另起（只补字符、不改上一条时间，避免重新引入跨停顿，也避免出现以「，」开头的字幕条）
- [x] 8.3 单测（test:engines，161 passed）：软切（达软宽度处逗号切）、不过碎（短逗号短语 < 软宽度保持一条）、顿号保护（「、」不软切，号码整条）、软时长闸（窄宽度但时长达标也切）、前导标点归属（gap 后逗号贴回上一条）、句末标点不受软宽度影响仍立即切
- [x] 8.4 真机复测同素材（`ASR ZH Longgap`，base / base-q8_0 一致）：粒度 **14 → 20 条**（与 faster-whisper 20 条对齐），gap 仍 **6**（无新增跨停顿）；逗号软切生效（`今天是2021年6月25日,` / `星期四,天氣情朗,` / `氣溫…制度。`）；电话号 `138、0013、800` 保持整条（顿号未切）；**无前导标点条**。剩余 `應用時分|廣泛`（`maxWidth=40` 硬上限）、`祝您工作順|利`（Silero 真实 0.55s 停顿）非 §6.2 范围

## 9. 合并单字碎片 cue（D10，弱模型/VAD 过切兜底）

- [x] 9.1 新增纯函数 `mergeShortCues(cues, { minContentChars=1, maxJoinGapSeconds=1.2, maxWidth=40 })`：实义字符数 ≤ 阈值的 cue，在与上一条间隔 ≤ 1.2s 且并入后宽度 ≤ maxWidth 时并入上一条（实义字符数而非显示宽度判定，避免漏判「字+全角标点」）
- [x] 9.2 `builtinEngine` 管道接入：`clampCuesToSegments` 之后、`trimSubtitleTrailingSilence` 之前
- [x] 9.3 单测（test:engines，167 passed）：单字假停顿并条（`廣`+`泛。`→`廣泛。`）、真实数秒停顿不并、达阈宽度 cue 不动、连续碎片级联、首条孤立碎片原样、并入超 maxWidth 不并
- [x] 9.4 真机无回归（`ASR ZH Longgap`，base / base-q8_0）：无单字碎片 → `merged short=0`、仍 20 条
- [x] 9.5 用户 `base` 日志暴露真因不在碎片阈值、而在 retime 把句尾尾字前向抛远 + 零时长 token 未处理 → 见 §10（run-aware 修复）

## 10. retime 改 run-aware 就近段贴齐（D11，修句尾尾字被抛 + 零时长塌条）

- [x] 10.1 重写 `retimeTokensToSpeech`：把「连续浮动内容 token」聚成 run，整 run 按「离前/后段更近」决定后向（平移到前段 end 紧接上一句）或前向（平移到后段 start）贴齐，保留 run 内相对偏移；删除逐 token 的 `snapContentTokenToSegment`
- [x] 10.2 零时长 token 按「点是否在段内」判 anchored：段内 → 原样保留（不被误判浮动抛走）；段外 → 计入浮动 run（前向贴到后段 start 后 gap=0、随后段首 token 合并，消除零时长孤条）
- [x] 10.3 更新/新增单测（test:engines，175 passed）：浮动 run 离后段近→前向、离前段近→后向贴齐；句尾尾字 `廣泛` 回贴上一句不被抛到下一句；多 token run 保序；零时长内容 run 前向合并；零时长 token 段内保留；retime+group 端到端（前向填充 anchored、句尾尾字合一条、零时长整句合并无零时长条）
- [x] 10.4 真机复测（`ASR ZH Longgap`，base / base-q8_0 一致）：用户两处反例均消除——`人工智能技術正在快速發展。` 合并为一条非零时长（`41,926→44,732`，原 `41,400→41,400` 零时长条消失）；`廣泛。` 收在 `49,400→49,916` 紧接 `…應用時分`、不再抛到 `53,862`、与下一句无重叠；19 条 / 6 gap / `merged short=0`，无回归、无零时长 cue
- [ ] 10.5 待用户用自有 `base` 素材复测确认尾字 / 零时长条均消除

## 11. 按 whisper 内部 VAD 分两条管道 + VAD-off 幻觉护栏（D12）

- [x] 11.1 harness VAD on/off A/B：`medium` / `base-q8_0` × VAD on/off，输出 `cues / gaps / inSilence / span` 对照。结论：VAD-on token 被静音填充（必须 retime+clamp 还原停顿）；VAD-off token 已贴近真实语流（`medium` group-only 即 19 条、`inSilence=0`），retime 反而负优化（`medium` 19→26、+2 幻觉）
- [x] 11.2 新增纯函数 `dropCuesInDeepSilence(cues, segments, { minSilenceDistanceSeconds=1.5 })`：只丢「离任意语音段 > 阈值的深静音」cue，保留重叠 / 贴边界（≤1.5s）真实尾字；空段 / 不可解析 cue 原样返回（优雅降级）
- [x] 11.3 `builtinEngine` 按 `vad.useVAD` 分管道：VAD-on=`retime→group→clamp→merge→trim`；VAD-off=`group→merge→dropCuesInDeepSilence→trim`（**VAD-off 已由 §12/D13 升级加入 clampDom**）
- [x] 11.4 单测（test:engines）：`dropCuesInDeepSilence` 丢深静音、保贴边界、保重叠、空段降级、阈值收紧效果；既有 retime/clamp/merge 测试无回归
- [x] 11.5 VAD-off 是否加 `clampCuesToSegments` 的二次 A/B：`clamp+drop` vs `drop-only` cue 数相同，但旧 clamp 因 token 与外部段漂移误夹（`请记录以下信息`→0.3s 不可读；`测试内容到此结束` 仍跨 8s 静音）→ **旧 clamp 否决**；停顿还原改由 §12/D13 的安全 `clampDom` 实现
- [x] 11.6 真机复测（`ASR ZH Longgap`）：`base-q8_0` VAD-on `full` 仍 19 条 / 6 gap / 0 幻觉（无回归）；VAD-off 两条贴边界真实文本（`請記錄`/`廣泛`）被护栏正确保留
- [ ] 11.7 待用户用自有 `medium`（关 VAD）素材复测确认条数变细且无深静音幻觉

## 12. VAD-off 安全停顿还原 `clampCuesToDominantSegments`（D13）

- [x] 12.1 harness diag 证 VAD-off token 时间轴**连续**（相邻 token gap>0.4s = 0）→ 停顿不在 token 里、需借外部段还原；retime（整体平移）/ 旧 clamp（锚任意重叠段）均因漂移误伤
- [x] 12.2 新增纯函数 `clampCuesToDominantSegments(cues, segments, { minSegmentCoverage=0.5, minDurationSeconds=0.3 })`：只把 cue 收进「实质覆盖（overlap/segLen ≥ 0.5）」的语音段、剪前导 / 尾随静音复现 gap；弱重叠（只擦段尾）跳过；只变窄不平移（绝不反序 / 重叠 / 搬运文本）；无强覆盖段 / 收敛过短 / 空段 → 原样降级
- [x] 12.3 `builtinEngine` VAD-off 管道接入：`group → clampCuesToDominantSegments → merge → dropCuesInDeepSilence → trim`（注释更正：token 连续、停顿靠外部段安全还原）
- [x] 12.4 单测（test:engines，187 passed）：前导静音收敛、弱重叠保原（修「请记录」夹碎）、无重叠原样、跨两段收 [首.start,末.end]、空段降级、收敛过短保原、长段内 cue 原样、覆盖率阈值可配置
- [x] 12.5 真机复测（`ASR ZH Longgap`，harness `clampDom+drop`）：`medium` 19 条 / **gap 0→9** / 幻觉 0；`base-q8_0` 19 条 / gap 3→12 / 幻觉 2（贴边界真实文本保留）。SRT 验证 `人工智能…` `37→45`⇒`41,926→44,732`、`测试内容到此结束` `62→70`⇒`01:08,070→01:09,884`、漂移的 `请记录` 保持 3.4s 不被夹碎
- [ ] 12.6 待用户用自有 `medium`（关 VAD）素材复测确认：条数细 + 文本准 + 句间停顿复现（无声不显字幕）

## 13. VAD 取舍的 UI 就地引导（D14，架构 review 落地）

- [x] 13.1 调查 `useVAD` 作用域：确认为全局设置，builtin / faster-whisper / funasr / qwen / fireRed 共用 → 翻转全局默认会回归 faster-whisper 等，否决「改默认值」
- [x] 13.2 设置页（`settings.tsx`）VAD 开关下新增常显 muted 提示 `vadBuiltinHint`（i18n zh/en 同步）：内置引擎关 VAD 更细更准、开 VAD 适合长音频/严格无声不显、其他引擎建议保持开启
- [x] 13.3 任务高级面板（`AdvancedSheet`）`vad.on/off` 文案各补内置引擎分段粒度差异（保留对 faster-whisper 仍成立的幻觉警告）
- [x] 13.4 `check:i18n` 通过、改动文件无 lint；仅文案、零行为/默认/管道变更
- [ ] 13.5 后续（Open Questions）：是否引入内置引擎专属 VAD 默认 / 阈值设置化 / 评估单管道删 retime

## 14. 多语种回归 + 最短可读显示时长 `enforceMinDisplayDuration`（D15）

- [x] 14.1 多语种素材：`say` 合成英/日长静音（句间插 4–7s 静音、总静音 ~30s），bundled ffmpeg（`@ffmpeg-installer`）转 16k 单声道 WAV；harness 参数化 `LONGGAP_WAV` / `LONGGAP_LANG`
- [x] 14.2 英/日 A/B（`medium` / `base-q8_0`）：clampDom+drop 句间停顿在 zh/en/ja 均还原（EN medium gap 5→9、JA medium gap 0→11）、无深静音幻觉（JA inSilence=0；EN 1 条为贴边界真实词正确保留）。诊断发现 VAD-off token 连续性**与语言相关**（zh/ja gap=0、en=5）
- [x] 14.3 暴露语言无关新缺口「文本正常但时长极短」cue：EN `Artificial…` 0.28s、JA 19 字 0.53s（maxWidth 硬切撞 whisper 边界压缩时间戳）；既有 merge/clampDom/drop 三道均兜不住
- [x] 14.4 新增纯函数 `enforceMinDisplayDuration(cues, { minDurationSeconds=0.8, perCharSeconds=0.06, maxDurationSeconds=2.5, guardGapSeconds=0.1 })`：只延末点到「期望可读时长」、封顶下一条起点前；绝不改起点/文本、不缩短、不重叠；末条不延（交 trim）
- [x] 14.5 `builtinEngine` 两条管道末尾共用（`refined → enforceMinDisplayDuration → trimSubtitleTrailingSilence`）
- [x] 14.6 单测（test:engines，197 passed，+10）：硬下限延长、按字数缩放、guardGap 封顶、下一条过近原样、末条不延、空输入、够长仅规范化、不可解析原样、perCharSeconds=0 关缩放、可配置下限
- [x] 14.7 真机复测（英/日 harness）：短 cue 数 JA medium VAD-off 1→0（gap 11→11 无损）、JA base VAD-on 3→1、EN base VAD-on 2→1；EN medium VAD-off 0.28→0.51s（下一条过近、部分改善）；4–7s 长静音全保留
- [x] 14.8 harness 入库整理：临时 `/tmp` 脚本 → `scripts/longgap/`（`fixtures.ts` 三语种脚本+静音布局单一数据源 / `gen-audio.ts` say+自带 ffmpeg 合成 16k WAV / `run.ts` 逐语种×模型×VAD on/off 矩阵+汇总表 / `README.md`）；新增 `npm run test:longgap`、`longgap:gen`；生成物 `.longgap/` 入 gitignore；删除旧 `scripts/test-builtin-longgap.ts`
- [x] 14.9 三语种全量真机复跑（medium+base-q8_0×VAD on/off）：gaps 处处 >0（停顿还原）、inSilence≈0（少量为贴边界真实词）、short 经 D15 普降（如 ja medium 2→0/1→0、en medium off 3→2）
- [ ] 14.10 后续（Open Questions）：带背景音乐 / 真实长素材回归；`perCharSeconds` 等阈值是否设置化

## 15. 硬切回溯到最近可断标点（D16，云端 ASR 词级对比发现）

- [x] 15.1 复现：阿里云词级结果（`ASR ZH Longgap`）经管线后「廣泛。」被 `maxWidth=40` 孤切成条（D9 已知残例）；四档 maxWidth（32/36/40/48）实测确认 40 仍是中英甜点，问题在切分位置而非阈值
- [x] 15.2 `groupTokenCues` 重构：当前 cue 改逐 token 缓冲（保留每词真实时间）；硬上限触发时回溯到最后一个可断标点（`HARD_BREAK_PUNCT`，含顿号/冒号——软切仍排除）后分割，余部以真实词时间作新 cue 开头；余部+本词仍超限则余部单独成条（不超宽不变式，单字余部交 mergeShortCues）；无可断标点时行为与回溯前一致
- [x] 15.3 单测（test:engines，440 passed，+6）：逗号回溯、顿号回溯（对照软切排除）、无标点降级、余部超限单独成条、拉丁词真实时间回溯、真实阿里云语料回归（`語音識別、|機器翻譯…廣泛。`）
- [x] 15.4 真实文件复验（仓库编译产物 + 阿里云词级结果）：20→20 条，仅 2 处变化——`大家好，|欢迎…音频。`（恢复 API 原句边界）与 `語音識別、|…廣泛。`；其余 18 条逐毫秒不变；云端六家与本地引擎共用同函数、同时受益
