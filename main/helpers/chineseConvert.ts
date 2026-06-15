/**
 * 中文简繁自动归一：当源语言为中文时，把「转写生成」的字幕统一成期望字形。
 *
 * 背景：Whisper 的 `zh` 不区分简/繁，简繁由模型解码倾向决定（tiny/base 强烈倾向繁体），
 * initial_prompt 又压不住。此处用纯 JS 的 opencc-js（词组级，无原生依赖）做确定性后处理。
 * 仅当检测到「相反字形」时才实际转换（转换前后不同即命中），避免无谓改写。
 */
import { Converter } from 'opencc-js';

export type ChineseScript = 'simplified' | 'traditional';

type ConvertFn = (text: string) => string;

let t2sConverter: ConvertFn | null = null;
let s2tConverter: ConvertFn | null = null;

/** 繁（OpenCC 标准）→ 简（大陆）。惰性创建并缓存。 */
function getT2S(): ConvertFn {
  if (!t2sConverter) t2sConverter = Converter({ from: 't', to: 'cn' });
  return t2sConverter;
}

/** 简（大陆）→ 繁（OpenCC 标准）。惰性创建并缓存。 */
function getS2T(): ConvertFn {
  if (!s2tConverter) s2tConverter = Converter({ from: 'cn', to: 't' });
  return s2tConverter;
}

/**
 * 由源语言代码推断期望中文字形：
 * - `zh` / `zh-CN` / `zh-Hans` → 'simplified'
 * - `zh-Hant` / `zh-TW` / `zh-HK` → 'traditional'
 * - 其它（含 `auto`、`yue` 粤语、非中文）→ null（不自动转换）
 */
export function getDesiredChineseScript(lang?: string): ChineseScript | null {
  if (!lang) return null;
  const c = lang.toLowerCase();
  if (!c.startsWith('zh')) return null;
  if (c.includes('hant') || c.includes('tw') || c.includes('hk')) {
    return 'traditional';
  }
  return 'simplified';
}

/**
 * 按期望字形转换文本；仅当结果与原文不同（即检测到相反字形）时标记 converted。
 * 对 SRT 全文安全：序号/时间码/`-->` 均为 ASCII，OpenCC 不会改动。
 */
export function convertChineseText(
  text: string,
  desired: ChineseScript,
): { text: string; converted: boolean } {
  if (!text) return { text, converted: false };
  const convert = desired === 'simplified' ? getT2S() : getS2T();
  const out = convert(text);
  return { text: out, converted: out !== text };
}
