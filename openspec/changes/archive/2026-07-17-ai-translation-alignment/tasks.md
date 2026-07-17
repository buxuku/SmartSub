# Tasks: AI 批量翻译条数与语义对齐

## 1. 解析与校验基础（先行，保证双形态兼容后才能切协议）

- [x] 1.1 新增 `main/translate/utils/similarity.ts`：文本归一化（去标点/空白/小写）+ Levenshtein 相似度（0~1）
- [x] 1.2 升级 `main/translate/utils/aiResponseParser.ts`：支持值为 `{src, tr}` 对象与纯字符串双形态，导出锚定解析结果类型（含逐条 src/tr/形态标记）
- [x] 1.3 扩展 `scripts/test-ai-response-parser.ts`：双形态、混合形态、think 标签混入、markdown 包裹等用例
- [x] 1.4 运行 `yarn test:translate-parser` 通过

## 2. 动态 Schema 与服务层通道

- [x] 2.1 `main/translate/constants/schema.ts` 新增 `makeBatchSchema(ids, { echo })` 工厂（echo 与非 echo 两种形态），保留静态 `TRANSLATION_JSON_SCHEMA` 兼容既有调用方
- [x] 2.2 `main/translate/types/index.ts` 的 `TranslationRequestOptions` 增加 `responseJsonSchema?: Record<string, unknown>`
- [x] 2.3 `main/service/ollama.ts`：json_schema 模式优先使用 `options.responseJsonSchema`，附带的 system prompt schema 说明同步动态化
- [x] 2.4 `main/service/openai.ts`：json_schema 路径由 `zodResponseFormat` 改为原生 `response_format: { type:'json_schema', json_schema:{ name, strict:true, schema } }`（未传 schema 时保持旧行为）
- [x] 2.5 `main/service/azureOpenai.ts`：同 2.4 使用动态 schema
- [x] 2.6 扩展 `scripts/test-structured-output-fallback.ts`：动态 schema 透传、未传 schema 向后兼容、降级链不受影响
- [x] 2.7 运行 `yarn test:structured-output` 通过

## 3. 批次组装、回显校验与失败分级（ai.ts 主流程）

- [x] 3.1 `main/translate/services/ai.ts`：批次组装按 `echoAnchoring` 构造 `{id:{src,tr}}` 或 `{id:text}` 输入与对应动态 schema，经 options 下发
- [x] 3.2 批次超过 100 条时自动二次拆分（schema 属性数上限保护）
- [x] 3.3 实现回显校验：逐条相似度比对（阈值 0.75）+ 空值检测，产出错位条目清单；纯字符串形态降级为条数+空值校验
- [x] 3.4 实现 `repairEntry()` 单条定点补翻：±2 条原文+已译文上下文（标注仅参考勿翻译、目标句单独引用）、单键 schema、最多 3 次
- [x] 3.5 重构失败分级：不可解析或错位 >1/3 → 整批重试一次；个别问题条目 → 定点补翻；补翻耗尽 → 仅该条标记失败、其余入库
- [x] 3.6 日志补充：错位检出数、补翻次数、最终对齐率（沿用 logMessage 通道）

## 4. 配置、提示词迁移与 UI

- [x] 4.1 `types/provider.ts`：`defaultSystemPrompt` 升级为 {src,tr} 协议（含示例）；旧默认追加进 `HISTORICAL_DEFAULT_PROMPTS`；AI 渠道新增 `echoAnchoring` 字段（默认 true）
- [x] 4.2 `main/helpers/providerManager.ts`：`CURRENT_PROVIDER_VERSION` 20 → 21，迁移逻辑覆盖 echoAnchoring 默认值与提示词升级
- [x] 4.3 `renderer/components/ProviderForm.tsx`：echoAnchoring 开关（switch 字段自动渲染）；检测自定义提示词不含 src/tr 协议时展示更新提示（实际落点为 ProviderForm 而非 ProvidersTab，字段渲染集中于此）
- [x] 4.4 `renderer/public/locales/{zh,en}/translateControl.json`：新增开关 label/tips、提示词更新提示、batchSize 上限说明；运行 `yarn check:i18n` 通过
- [x] 4.5 运行 `yarn test:glossary` 通过（提示词变更不破坏词库变量校验）

## 5. 端到端验证

- [x] 5.1 本地 ollama（gemma2:2b）实测：91 条字幕批量 45，验证条数 100% 对齐、错位检出与补翻日志正确（`E2E=1 yarn test:alignment-e2e` S1：3 批全对齐，回显 91/91 直接通过）
- [x] 5.2 制造合并场景（deepseek-r1:7b 批量 45）：验证滑移条目被检出并修复（S2：flagged=1 → repaired=1，最终 45/45）
- [x] 5.3 自定义提示词回归：旧 `{id:text}` 协议提示词下翻译不中断（S3：优雅降级，20/20 完成）；UI 提示由 ProviderForm echoPromptOutdatedHint 覆盖
- [x] 5.4 json_object 降级回归：无 schema 约束下回显协议仍工作（S4：提示词驱动回显 17/20，flagged 3 → 全部补翻，20/20）
- [x] 5.5 `yarn build` 通过

## 6. 实施中发现并修复的问题

- [x] 6.1 ollama.ts 原实现把 JSON Schema 全文内嵌 system prompt——动态批次 schema 体积随批量线性增长（45 条 echo schema ≈ 3900 tokens），叠加 ollama 默认 num_ctx 挤爆上下文窗口、原文被截断导致回显崩坏（对照实验：内嵌+默认 ctx = 44/45 错位；仅去内嵌 = 0/45）。修复：传入动态 schema 时不再内嵌 schema 全文，仅留一句格式说明；显式设置 num_ctx=8192 + temperature 0.3
- [x] 6.2 ollama 渠道默认 structuredOutput 升级为 json_schema（本地小模型条数对齐收益最大，旧版 ollama 由回退链自动降级），v21 迁移同步既有配置（用户显式 disabled 保留）
