# Tasks: fix-ai-segmentation-resilience

## 1. 保留最好的一轮（P1）

- [x] 1.1 `validator.ts` 新增 `compareValidations`：内容可用优于被改写；同为可用时超长段更少、超出总量更小者优先；被改写时相似度高者优先
- [x] 1.2 `segmentationRunner.ts` 的 `processWindow` 改为保留最好的一次：反馈提示基于最好的一次；模型原样重复同一答案则不再重试；重试轮请求失败且已有可用答案时沿用它（不计为服务不可达，取消与配置错误仍上抛）；降级时日志区分原因并带出首条定位信息
- [x] 1.3 新增 `scripts/test-ai-segmentation-runner.cjs` 并接入 `test:refine`（以假模型脚本化各轮输出，不碰网络）；覆盖：首轮正确的答案不被后续改坏的重试覆盖、反馈基于最好答案、后续轮修好超长时胜出、可用答案间取超长更少者、重试请求失败沿用已有答案、首轮失败只降级该窗、全窗首轮失败整体降级、降级日志含原因、重复答案提前结束、重试中取消仍取消整个阶段

## 2. 请求限时（P2）

- [x] 2.1 `TranslationRequestOptions` 新增可选的 `timeoutMs` / `maxRetries`
- [x] 2.2 新增 `main/service/sdkRequestOptions.ts`，`openai.ts`（3 处）与 `azureOpenai.ts`（1 处）把它们透传给 SDK 的逐请求选项；其余服务商忽略
- [x] 2.3 `segmentationRunner.ts`：尚无可用答案时每次尝试限时 300 秒并保留 SDK 默认重发；已有可用答案后的重试限时为 `min(300, max(60, 2 × 此前最慢请求))` 秒且不重发
- [x] 2.4 测试：限时参数的取值与适应规则；`toSdkRequestOptions` 只透传调用方设置的字段；`translateWithOpenAI` / `translateWithAzureOpenAI` 在卡住的服务端上按 `timeoutMs` 放弃；对照用例证明不设 `maxRetries` 时 SDK 会把超时重发（即该选项存在的原因）；限时不影响健康请求

## 3. 容差与重锚定（P3）

- [x] 3.1 新增 `main/helpers/subtitleRefine/anchoring.ts`：骨架提取（NFKD、小写、仅保留字母数字与组合符号）→ jsdiff 对齐（带编辑量上限）→ 把模型断点映射回原文位置（收尾标点归左、起始引号 / 括号 / 货币符号归右、不切开码点）
- [x] 3.2 `validator.ts` 接入：严格等值路径不变；容差内放行时返回 `tolerated` 与按断点切开的原文 `alignSegments`，限长检查针对 `alignSegments`；超出容差仍判为被改写并定位
- [x] 3.3 `segmentationRunner.ts` 对齐改用 `validation.alignSegments`，容差放行时记日志
- [x] 3.4 `scripts/test-refine-units.ts`：骨架对齐的手写用例（标点 / 大小写、少量改字、删词换词、短文本不放行、CJK、引号括号货币符号、全角与变音符、代理对、纯标点段）、校验器集成用例，以及固定种子的 4000 例随机性质测试（不丢字不重复、不切开代理对、只丢标点或大小写的副本从不被拒、随机丢 15% 字符基本全部被拒）
- [x] 3.5 `scripts/test-ai-segmentation-runner.cjs`：标点与大小写偏差一次通过且保留原标点、改字后字幕文字仍取自转写、容差放行有日志、超出容差仍降级、段级时间轴同样保留原文
- [x] 3.6 变异检验：把容差放大 10 倍、让断点差一、让间隙内按 UTF-16 单元前进（会切开代理对）、让标点一律归右，测试均能抓到

## 4. 文档与验证（P4）

- [x] 4.1 `docs/docs/advanced/ai-refine.md`：补充容差、请求限时、从日志判断是否降级及原因
- [x] 4.2 `openspec validate fix-ai-segmentation-resilience --strict` 通过
- [x] 4.3 `npm run typecheck` 通过
- [x] 4.4 相关测试通过：`test:refine`（108 + 30 + 25）、`test:translation-cancel`、`test:provider-fallback`、`test:translation-proxy`、`test:custom-parameters`
- [x] 4.5 `npm run test:pro-baseline` 通过（41 条测试命令，含新增的运行器测试）
- [ ] 4.6 真实服务商冒烟：用 #507 的素材（faster-whisper + SiliconFlow、12 个窗口）跑一次，对比 `degradedWindows`。**尚未执行**：以上全部验证基于脚本化的假模型与随机性质测试，没有请求过真实模型

## 5. 失败诊断（P5，PR 合入后追加，见 design D7）

- [x] 5.1 `anchoring.ts`：抽出放行与诊断共用的骨架比对（`diffSkeletons`）；新增 `describeDifferences` 与 `REPORT_MIN_SIMILARITY`（0.75）：预算内给精确相似度与逐处差异（扩成整词、合并碎片、重复字母夹在词界时向外取邻词）；超出预算给整块区域与相似度下界（`exact = false`）
- [x] 5.2 `validator.ts`：被拒绝的反馈首行带真实相似度、放行阈值、差异处数与第一处差异，其余最多 4 处在下一行，超出写 `and N more`；`SegmentationValidation` 新增 `similarityExact`，`formatSimilarity` 负责日志展示（整段被改写写 `<75%`）；删除按前后缀估算的 `locateDifference`；`clip` 不再劈开代理对
- [x] 5.3 `segmentationRunner.ts`：校验失败日志改用 `formatSimilarity`
- [x] 5.4 先写失败测试再实现（改动前：三处改词、真实相似度 88.5% 的复制被记成 15.7%，整段无关回复记成 0.0%，降级原因是一整串去掉空白的字母）。`scripts/test-refine-units.ts`：200 词窗口十处同义词替换（94.5% 记成 94.5%、十处逐一列出、排在整段重写的答案之前）、`describeDifferences` 手写用例（换词 / 词间插入 / 删词 / CJK / 多处 / 超出预算 / 空输入 / 大窗口耗时上限）、随机性质测试扩展（新增整段倒序改写模式；逐例核对不抛异常、相似度与独立的完整 diff 一致且超出预算时是下界、逐处差异里没有被劈开的代理对、没有空差异、没有两侧一样的差异）
- [x] 5.5 `scripts/test-ai-segmentation-runner.cjs`：近似复制按真实相似度记日志且三处差异都回喂模型；整段无关回复的日志写 `<75%`；降级原因带第一处具体差异
- [x] 5.6 变异检验：把诊断预算调到 0.97、关掉重复字母的扩词，测试均能抓到
- [x] 5.7 `docs/docs/advanced/ai-refine.md` 补充 `similarity` 与降级原因里差异的读法；proposal 与 design 更正「窗口 2、8 是模型在大幅改写」这一未经证实的推断
- [x] 5.8 验证：`test:refine`（170 + 30 + 28）、`test:pro-baseline`（42 条命令全部通过）、`npm run typecheck`、`openspec validate fix-ai-segmentation-resilience --strict`；诊断耗时抽样：500 词的窗口一次失败校验中位数 ≤ 55 ms
