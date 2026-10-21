# Tasks: split-qwen-asr-long-segments

## 1. 分支与脚手架

- [x] 1.1 从 `fix/issue-549-qwen-asr-long-segments`（#562）的末端新建 `fix/issue-549-qwen-asr-hard-split`，叠在它之上，不改动它
- [x] 1.2 `openspec new change` 并撰写 proposal / design / specs / tasks，`openspec validate split-qwen-asr-long-segments --strict` 通过
- [x] 1.3 本机切点探针（不入库，先于定稿参数）：55 段残余停顿合成语音与 2 段完全无停顿合成语音，对比「搜索最安静帧」与「等距」两种切点。结果与方法写入 design.md，选定 r = 2 秒

## 2. 切分纯函数（测试先行）

- [x] 2.1 先写失败测试 `scripts/test-segment-split.cjs`，并入 `yarn test:engines`：不超过上限与恰好等于上限不切；56 秒切成 4 片、每片不超过 20 秒、首尾相接且覆盖整段；在已知位置挖出静音谷的合成信号里，切点落在谷里；全零或平坦信号等分；上限较小（如 8.6 秒、1 秒）时切点仍严格递增、每片不超过上限（r 取 L / 6）；末片不会极短；非有限数值、0、负数、小于 1 秒的上限返回单片。确认测试因文件不存在而变红。结果：先因模块不存在而变红；共 10 个用例（含 6 个上限 × 6 个总长倍数共 36 组的扫描、8 kHz 采样率、L = 8.6 秒的凹槽用例）。变异检查有效：关掉切点搜索使「切点落在谷里」用例变红；把半径系数从 L / 6 改回 L / 4 使凹槽用例变红
- [x] 2.2 实现 `extraResources/sherpa/worker/segment-split.js`（纯函数，无依赖），确认变绿。结果：10 个用例通过，已并入 `yarn test:engines`

## 3. worker 接入（测试先行）

- [x] 3.1 先写失败测试（`scripts/test-sherpa-worker.cjs`，补一条把 `segment-split.js` 映射到真实实现的 `require` 桩）：参数缺省、为 0 时与现在一致，既有断言不变；56 秒的单段加上限 20 得到 4 次解码，cue 起止连续，`vadSegments` 为 4 片，`splits` 有一项；第 2 片之后取消，不再解码后面的片并回报已取消；已处理秒数随片递增。确认变红。结果：新增 `verifyHardSplit()`（上限缺省 / 为 0 时与现在一致、56 秒切 4 片、cue 首尾相接、`splits`、已处理秒数、取消、空文本的片不出 cue）；先因 `splits` 为 undefined 而变红。变异检查有效：去掉每片解码前的取消判断，「取消后不再解码后面的片」用例变红
- [x] 3.2 `sherpa-worker.js` 的 `transcribe()` 接入切分与 `splits`，确认变绿。结果：`transcribe()` 抽出 `decodeUnit`，`drain()` 按 `segment_hard_max_s` 调 `splitSegment`；变绿

## 4. Qwen3-ASR 启用与告警联动（测试先行）

- [x] 4.1 先写失败测试：`scripts/test-engine-units.ts` 覆盖 `segment_hard_max_s`（默认 20；预算 256 / 128 得 8.6；预算 100 / 128 得 1；其他引擎的参数里没有它）；`scripts/test-qwen-scaffold.cjs` 覆盖请求里带该参数且预热与转写一致、worker 回报 `splits` 时记一条 info、切分后的 `vadSegments` 不触发超预算 warning、仍有 45 秒的片时 warning 照常。确认变红。结果：另在 `scripts/test-sherpa-runtime-failures.cjs` 增加「`splits` 原样透传、没有时不带该键」一项（17 → 18 项）；引擎单测 1127 → 1137 项。先变红：tsc 报缺少 `qwenFitSeconds` / `qwenSegmentHardMaxSeconds` / `segment_hard_max_s`；scaffold 报 `undefined !== 20` 与 `0 !== 1`
- [x] 4.2 `qwenParams.ts`（参数）、`sherpaFunasrRuntime.ts`（`splits` 与参数的类型透传）、`qwenEngine.ts`（info 日志、告警对象），确认变绿。结果：`qwenParams.ts` 新增 `qwenFitSeconds` 与 `qwenSegmentHardMaxSeconds`，`segment_hard_max_s` 放在参数的最后一个键，超预算查找改用同一个 `qwenFitSeconds`；`sherpaFunasrRuntime.ts` 只在 worker 回报时带 `splits`；`qwenEngine.ts` 增加 `describeSplits` 的 info 日志；变绿。变异检查有效：无条件带 `splits` 键使既有的结果形状断言变红，空列表也记日志使引擎抛错

## 5. 文档

- [x] 5.1 `docs/docs/guides/engines/qwen3-asr.md` 常见问题改写：切分策略、切点可能落在词中、日志里 info 的样子；更新页脚日期。结果：旧条目改写为两层处理的说明，页脚日期仍为 2026-10（同月未改）。措辞按探针数据收紧：切点写「大多会落在停顿里」（探针是 93–100%，不是 100%）

## 6. 本机验证

- [x] 6.1 `yarn typecheck`：通过
- [x] 6.2 `yarn test:engines`：通过（引擎单测 1137 项 0 失败；sherpa worker 含硬切分用例；运行时失败 18 项；wav-io 22 项；Qwen scaffold；`test-segment-split.cjs` 10 项）
- [x] 6.3 `yarn test:scenario-presets`：通过
- [x] 6.4 `yarn check:i18n`：通过
- [x] 6.5 `openspec validate split-qwen-asr-long-segments --strict`：通过
- [x] 6.6 `prettier --check` 覆盖本分支改动的全部文件：通过（17 个文件）
- [x] 6.7 核对 `electron-builder.yml` 在 mac、win、linux 三处对 `extraResources/sherpa/` 的规则覆盖新文件；用 `worker_threads` 跑真实 worker 的脚本（如 `scripts/test-sherpa-runtime-failures.cjs` 所在链路）能 `require` 到它。结果：`electron-builder.yml` 的 mac、win、linux 三处都以 `**/*` 整目录打包 `./extraResources/sherpa/`（mac 另外只排除重复的 `libonnxruntime.dylib`），新文件在内。另在真实的 `worker_threads` 里启动一次真实 worker 文件：`detectSpeech` 在真实 VAD 上返回结果；把 `segment-split.js` 暂时挪走后同一脚本以 `Cannot find module` 失败，说明它确实是运行时依赖，随后已放回。`scripts/test-sherpa-runtime-failures.cjs` 用的是假 worker 宿主，不算这条的证据；仓库里其他跑真实 worker 的脚本（`smoke-parakeet.cjs`、`windows-nonascii/*`）需要模型或 Windows，本机没有跑
- [x] 6.8 本机一次性核对（不入库）：真实 Silero VAD + 真实 worker 代码（`vm` 加载）+ 假识别器，在无停顿素材（145 秒 / 123 秒）上确认每个解码单元不超过 20 秒、cue 首尾相接、`splits` 非空；同一素材不带参数时仍是一整段。结果：中文 145.34 秒的素材，不带参数是 1 个解码单元（145.27 秒），带 20 秒上限得到 10 片、最长 17.76 秒；英文 122.77 秒的素材，1 个单元（122.71 秒）变成 8 片、最长 16.34 秒；两次的解码总时长相同。每片不超过 20 秒、片间首尾相接、片合起来与原 VAD 段的首尾完全重合，`splits` 只列超过上限的段且片数与实际解码的一致，不带参数时 `splits` 为空列表。数据与观察见 design.md「真实 VAD 核对」

## 7. 未验证项（需要真实环境，请勿当作已验证）

- [ ] 7.1 真实 Qwen3-ASR 模型对被切开的无停顿语音的识别质量：本机没有模型。请 issue 作者用 silenceremove 素材（40 秒以上）复测，确认不再出现 `language` / 空文本，并看段边界处是否仍有丢词或重复
- [ ] 7.2 真实录音里切点落在停顿里的比例：探针只有合成语音，门限 −45 dBFS 是造素材时的门限
- [ ] 7.3 打包后的应用里 worker 能找到 `segment-split.js`：本机与 CI 只验证到打包规则与 `worker_threads` 路径，没有跑打包产物

## 8. 后续（不在本次范围）

- [ ] 8.1 评估把触发线与片长上限分开（design 的 Open Questions），减少对 20–28 秒、原本放得进预算的段的切分
- [ ] 8.2 评估给 FireRedASR 启用：先核实模型的长度上限，再看它自己的段长闸够不够
- [ ] 8.3 让切分提示与前一个变更的超预算告警一起进入任务界面
- [ ] 8.4 用 Silero 的语音概率代替能量找切点（design D2 的替代方案），仅当真实素材显示能量法不够好时
