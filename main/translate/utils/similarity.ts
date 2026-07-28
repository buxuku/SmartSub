/**
 * 回显锚定的文本相似度工具。
 *
 * 用于比对模型回显的原文（src）与真实字幕原文：合并/滑移错位发生时
 * 回显必然与该 ID 的真实原文对不上，以归一化编辑相似度做确定性检测。
 */

const NON_LETTER_OR_NUMBER = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

/**
 * 归一化：兼容 Unicode 的大小写与宽度归一，去掉标点和空白。
 *
 * 使用 Unicode 字符类别而不是枚举部分脚本，避免俄语、阿拉伯语等内容
 * 在比较前被清空。
 */
export function normalizeForComparison(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(NON_LETTER_OR_NUMBER, '');
}

/** 两行 DP 的 Levenshtein 距离，批次内逐条比对为毫秒级。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * 归一化编辑相似度（0~1）。1 表示完全一致。
 * 归一化后任一方为空时返回 0（无法判定视为不匹配）。
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const distance = levenshtein(na, nb);
  return 1 - distance / Math.max(na.length, nb.length);
}

/** 回显 src 与真实原文的判定阈值（实测 0.75 可区分正常改写与合并滑移）。 */
export const ECHO_SIMILARITY_THRESHOLD = 0.75;
