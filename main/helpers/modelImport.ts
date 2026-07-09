import fs from 'fs';
import path from 'path';

/**
 * 模型路径与本地导入的纯逻辑（仅依赖 fs/path，无 Electron），便于 test:engines 在 node 下单测。
 * 路径覆盖解析 / 文件夹布局校验 / CT2 导入常量集中于此。
 */

/**
 * 解析模型根目录：用户覆盖值（非空字符串）优先，否则回退默认路径。
 * 空串 / 仅空白 / undefined 视为未设置。
 */
export function resolveOverridePath(
  override: string | undefined | null,
  fallback: string,
): string {
  const trimmed = typeof override === 'string' ? override.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
}

export interface LayoutCheckResult {
  ok: boolean;
  missing: string[];
}

/**
 * 校验源目录是否含某模型的全部必需文件。
 * requiredFiles 支持嵌套相对路径（如 `tokenizer/vocab.json`），逐项检查存在性。
 */
export function validateModelLayout(
  srcDir: string,
  requiredFiles: string[],
): LayoutCheckResult {
  const missing = requiredFiles.filter(
    (rel) => !fs.existsSync(path.join(srcDir, rel)),
  );
  return { ok: missing.length === 0, missing };
}

/**
 * sherpa 系共享 VAD（silero）随应用内置的相对子路径（相对 extraResources 根）。
 * funasr / qwen / fireRedAsr 共用这一份；与各引擎可自定义的模型根目录解耦。
 */
export const SHERPA_VAD_SUBPATH = path.join('sherpa', 'vad', 'silero_vad.onnx');

/** 由 extraResources 根拼出内置 silero VAD 的绝对路径（纯函数，便于单测）。 */
export function resolveBundledVadPath(extraResourcesRoot: string): string {
  return path.join(extraResourcesRoot, SHERPA_VAD_SUBPATH);
}

/** 随包 gtcrn 降噪模型（克隆参考音频的本地降噪可选项）。 */
export const SHERPA_DENOISE_SUBPATH = path.join(
  'sherpa',
  'denoise',
  'gtcrn_simple.onnx',
);

export function resolveBundledDenoisePath(extraResourcesRoot: string): string {
  return path.join(extraResourcesRoot, SHERPA_DENOISE_SUBPATH);
}

/** CT2(faster-whisper) 模型导入的最小必需文件集（模型权重 + 配置）。 */
export const CT2_REQUIRED_FILES: string[] = ['model.bin', 'config.json'];

/** 导入的 CT2 模型落地的合成快照 revision 名，供 resolveCt2ModelSnapshotDir 命中。 */
export const CT2_IMPORT_SNAPSHOT_REV = 'imported';
