/** addon 与 py-engine 共用的二进制下载源（与 HuggingFace 模型源无关）。 */
export type BinaryDownloadSource = 'github' | 'ghproxy' | 'gitcode';

/**
 * 回退规范顺序：国内优先（先域内 gitcode，再代理 ghproxy，最后直连 github）。
 * 所选源永远排第一，其余按此顺序补齐。
 */
export const DEFAULT_SOURCE_ORDER: BinaryDownloadSource[] = [
  'gitcode',
  'ghproxy',
  'github',
];

export function getSourceFallbackOrder(
  selected: BinaryDownloadSource,
): BinaryDownloadSource[] {
  return [selected, ...DEFAULT_SOURCE_ORDER.filter((s) => s !== selected)];
}
