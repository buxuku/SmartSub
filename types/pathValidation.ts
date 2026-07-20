/**
 * 存储路径校验（主进程与渲染层共享，零 Electron/Node 依赖）。
 *
 * 背景：whisper.cpp / sherpa-onnx 在 Windows 非 UTF-8 locale 下以 ANSI
 * codepage 打开文件，含中文（CJK）字符的模型路径会直接打不开文件，是
 * 历史上一批「模型加载失败」问题的根源。所有目录选择入口统一硬阻止。
 */

/**
 * 检测字符串是否含 CJK 字符。
 * 覆盖：CJK 标点(U+3000-303F)、扩展A(U+3400-4DBF)、统一表意文字(U+4E00-9FFF)、
 * 兼容表意(U+F900-FAFF)、全角/半角形式(U+FF00-FFEF)。
 * 有意不拦截西文变音符等无兼容风险的非 ASCII 字符。
 */
const CJK_PATTERN =
  /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function containsCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}

export type StoragePathValidation = { ok: true } | { ok: false; reason: 'cjk' };

/** 目录选择入口的统一校验：含 CJK 字符即拒绝。 */
export function validateStoragePath(value: string): StoragePathValidation {
  if (containsCjk(value)) {
    return { ok: false, reason: 'cjk' };
  }
  return { ok: true };
}
