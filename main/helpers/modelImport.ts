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

/** CTranslate2 Whisper 转写阶段会直接迭代的配置数组。 */
export const CT2_REQUIRED_CONFIG_ARRAYS: string[] = [
  'lang_ids',
  'suppress_ids',
  'suppress_ids_begin',
];

/** 导入的 CT2 模型落地的合成快照 revision 名，供 resolveCt2ModelSnapshotDir 命中。 */
export const CT2_IMPORT_SNAPSHOT_REV = 'imported';

export interface Ct2SnapshotValidation {
  ok: boolean;
  issues: string[];
}

export interface Ct2SnapshotInspection extends Ct2SnapshotValidation {
  snapshotDir: string | null;
  incompleteSnapshotDir: string | null;
}

/**
 * 校验 faster-whisper/CT2 快照的最小可加载条件。
 * 除必需文件存在外，文件必须非空，且 config.json 必须是 JSON 对象，避免把
 * CTranslate2 的底层 JSON 异常暴露到转写阶段。
 */
export function validateCt2ModelSnapshot(
  snapshotDir: string,
): Ct2SnapshotValidation {
  const issues: string[] = [];

  for (const rel of CT2_REQUIRED_FILES) {
    const filePath = path.join(snapshotDir, rel);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0) issues.push(`${rel} is empty`);
    } catch {
      issues.push(`${rel} is missing`);
    }
  }

  const configPath = path.join(snapshotDir, 'config.json');
  if (!issues.some((issue) => issue.startsWith('config.json'))) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        issues.push('config.json is invalid');
      } else {
        for (const key of CT2_REQUIRED_CONFIG_ARRAYS) {
          if (!Array.isArray((config as Record<string, unknown>)[key])) {
            issues.push(`config.json.${key} is missing or invalid`);
          }
        }
      }
    } catch {
      issues.push('config.json is invalid');
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 在一个 snapshots 目录中优先返回完整快照，同时保留首个残缺快照的诊断。 */
export function inspectCt2SnapshotRoot(
  snapshotRoot: string,
): Ct2SnapshotInspection {
  if (!fs.existsSync(snapshotRoot)) {
    return {
      ok: false,
      snapshotDir: null,
      incompleteSnapshotDir: null,
      issues: [],
    };
  }

  let firstIncomplete: Ct2SnapshotInspection | null = null;
  const revisions = fs
    .readdirSync(snapshotRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const revision of revisions) {
    const snapshotDir = path.join(snapshotRoot, revision.name);
    const validation = validateCt2ModelSnapshot(snapshotDir);
    if (validation.ok) {
      return {
        ...validation,
        snapshotDir,
        incompleteSnapshotDir: null,
      };
    }
    if (!firstIncomplete) {
      firstIncomplete = {
        ...validation,
        snapshotDir: null,
        incompleteSnapshotDir: snapshotDir,
      };
    }
  }

  return (
    firstIncomplete || {
      ok: false,
      snapshotDir: null,
      incompleteSnapshotDir: null,
      issues: [],
    }
  );
}
