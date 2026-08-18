/**
 * 产品级通读摘要提示词。
 *
 * 与翻译服务商的 systemPrompt（src/tr JSON 协议）物理分离：摘要服务可以
 * 不是翻译服务，且摘要输出是纯文本，不能走回显协议。
 *
 * settings.summaryPrompt 存用户改写版；空 / 缺省 / 空白回落本出厂稿，
 * 不做首启动写死迁移，避免把后续出厂更新锁进用户商店。
 */

export const defaultSummaryPrompt = `# Role: 字幕分析助手
你是字幕分析助手。下面是当前\${sourceLanguage}字幕（每行：id<TAB>原文）。

# Attention
请用\${targetLanguage}输出「翻译用摘要」（供后续分批翻译时作为语境参考），不得超过 400 字，必须包含：

1. **内容概述**：当前这段字幕在讲什么，涉及什么话题或场景。
2. **关键说话人与指称**：当前字幕中出现的说话人、被提及者，以及他们之间的称呼方式。仅限当前字幕内出现的，不要补写未见内容。
3. **语气基调与未决信息**：说话人的语气特征（正式/随意/讽刺/紧张等），以及在当前批次中未交代完、可能影响后续翻译连贯性的信息。
4. **称谓、专有名词及潜在歧义**：点出容易混的叫法或未决指称，**仍用源字幕里的写法**。若篇幅紧张，本条可压缩。

专名规则（摘要是给后续翻译批次看的语境，不是译文本身）：
- 人名、地名、建制、称谓一律使用源字幕中的写法，以便和后续各批原文对齐。
- 若 instructions 中另附专有名词表：不要发明表外译名；**不要**把摘要里的专名改写成表内译文。译名由后续翻译批次的词库注入负责。
- 不要标注「（临时译法，待确认）」，不要另造一套中文叫法。

# 输出格式要求

1. 输入是当前字幕清单，每行 \`id<TAB>原文\`；无时间码；原文中的换行已压成 \` / \`。
2. 只输出摘要正文。
3. 不要 JSON，不要条目译文，不要 Markdown 标题堆砌，不要写成观众导视或影评。
4. 不要把相邻条目逐条翻译；这不是翻译任务。
5. 若篇幅紧张，优先保留第 1–3 条，压缩或省略第 4 条。

# Examples

Input:
\`\`\`
0	Welcome to China
1	China is a beautiful country
\`\`\`

Output:
开场欢迎听众来到中国，并称赞其风光。说话人面向听众，语气热情、介绍性。专名 China 保留原文；欢迎套语前后保持一致。
`;

/** 文件总 cue 数下限；再短压缩没有信息增益。 */
export const SUMMARY_MIN_CUES = 20;

/** 预计批次下限；单批时模型已看见全文。 */
export const SUMMARY_MIN_BATCHES = 2;

/** 与 refineProvider 同构的「跟随翻译服务」哨兵。 */
export const FOLLOW_TRANSLATION_PROVIDER = 'follow-translation';

export const SUMMARY_GLOSSARY_HEADING =
  '## 专有名词（对照用：摘要保持源文写法，不要改写成表内译文）';

export const SUMMARY_BLOCK_HEADING =
  '## 本集剧情摘要（翻译时请参考语境与人物状态，勿写入输出 JSON）';

export type SummaryErrorCode =
  | 'empty'
  | 'empty-after-think-strip'
  | 'skipped-trivial'
  | 'provider-unresolved'
  | 'provider-not-ai'
  | 'call-failed';

/** 空 / 空白 / 非字符串一律回落出厂稿。 */
export function resolveSummaryPrompt(stored?: unknown): string {
  if (typeof stored !== 'string') return defaultSummaryPrompt;
  const trimmed = stored.trim();
  return trimmed || defaultSummaryPrompt;
}
