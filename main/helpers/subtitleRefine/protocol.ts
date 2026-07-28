/**
 * 断句遍 LLM 协议编解码（design D3）：
 *  - 输入侧：把窗口内词/cue 文本拼成送 LLM 的连续原文；
 *  - 输出侧：解析模型返回的 `<br>` 插标文本为段列表。
 *
 * 协议约定「原文逐字不变、只插 <br>」，等值性由 validator 把关；本模块只管形态。
 */

import type { TokenTriple } from '../subtitleSegmentation';
import type { RefineWord } from './types';

/** 折叠连续空白为单空格（词文本自带前导空格的引擎形态在拼接后于此归一）。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Tier 'word'：窗口词序列 → 送 LLM 的原文（原样拼接 + 空白折叠）。 */
export function buildWindowText(words: RefineWord[]): string {
  return collapseWhitespace(words.map((w) => w.text ?? '').join(''));
}

/**
 * Tier 'segment'：cue 区间 → 送 LLM 的原文。cue 文本间以单空格相接：
 * CJK 相邻多出的空格会被规范化比对忽略；拉丁语相邻则必须有分隔，否则词会粘连。
 */
export function buildCueWindowText(
  cues: TokenTriple[],
  range?: [number, number],
): string {
  const [from, to] = range ?? [0, cues.length];
  return collapseWhitespace(
    cues
      .slice(from, to)
      .map((cue) => cue?.[2] ?? '')
      .join(' '),
  );
}

/**
 * 解析 LLM 的 `<br>` 插标输出为段列表：
 *  - 剥掉常见包裹（markdown 代码围栏）；
 *  - 删除换行（与卡卡一致：模型偶发的软换行不视为断点——若模型整篇用换行代替 <br>，
 *    会因单段超长走校验反馈循环纠正，行为可预期）；
 *  - 按 `<br>`（容忍 `<br/>` / `<BR>` 变体）切分，去空段。
 */
export function parseBrSegments(raw: string): string[] {
  let text = (raw ?? '').trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  text = text.replace(/\r?\n+/g, '');
  return text
    .split(/<br\s*\/?\s*>/i)
    .map((seg) => seg.trim())
    .filter(Boolean);
}
