/**
 * Fonts people reach for most often, in display order. Entries match a font's
 * family name or any localized family name (case-insensitive), so "PingFang SC"
 * and "苹方-简" are the same entry on every platform.
 */
export const COMMON_FONT_ORDER: string[][] = [
  ['PingFang SC', '苹方-简', '苹方'],
  ['Microsoft YaHei', '微软雅黑'],
  ['Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', '思源黑体'],
  ['HarmonyOS Sans SC'],
  ['MiSans'],
  ['Alibaba PuHuiTi', '阿里巴巴普惠体'],
  ['Heiti SC', '黑体-简'],
  ['SimHei', '黑体'],
  ['Hiragino Sans GB', '冬青黑体简体中文'],
  ['Songti SC', '宋体-简'],
  ['SimSun', '宋体'],
  ['STSong', '华文宋体'],
  ['Kaiti SC', '楷体-简'],
  ['KaiTi', '楷体'],
  ['FangSong', '仿宋'],
  ['Microsoft JhengHei', '微软正黑体'],
  ['PingFang TC', '苹方-繁'],
  ['Apple SD Gothic Neo'],
  ['Malgun Gothic'],
  ['Hiragino Sans'],
  ['Yu Gothic'],
  ['Meiryo'],
  ['Helvetica Neue'],
  ['Helvetica'],
  ['Arial'],
  ['Segoe UI'],
  ['Roboto'],
  ['Inter'],
  ['Verdana'],
  ['Tahoma'],
  ['Georgia'],
  ['Times New Roman'],
  ['Impact'],
  ['Menlo'],
  ['Consolas'],
  ['Courier New'],
  ['Arial Unicode MS'],
];

const normalize = (value: string) => value.trim().toLowerCase();

/** Index in {@link COMMON_FONT_ORDER}, or undefined for a less common font. */
export function commonFontRank(names: string[]): number | undefined {
  const wanted = new Set(names.filter(Boolean).map(normalize));
  const rank = COMMON_FONT_ORDER.findIndex((entry) =>
    entry.some((name) => wanted.has(normalize(name))),
  );
  return rank >= 0 ? rank : undefined;
}
