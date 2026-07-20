import path from 'path';
import { containsCjk } from '../../types/pathValidation';

/**
 * 统一存储根目录的解析核心（仅依赖 path，无 Electron，便于 node 下单测，
 * 先例 modelImport.ts）。
 *
 * 解析优先级（design D1）：
 *   引擎单独覆盖 > settings.storageRoot/<既有默认子目录名> > <默认基座>/<既有默认子目录名>
 *
 * mkdir 等副作用不在本模块：各 getter 拿到结果后自行确保目录存在（既有行为）。
 */

export type StorageSource = 'override' | 'storageRoot' | 'default';

export interface ResolvedStorageLocation {
  path: string;
  source: StorageSource;
}

/** 参与统一根目录解析的各用途标识。 */
export type StorageKind =
  | 'ggml'
  | 'ct2'
  | 'funasr'
  | 'qwen'
  | 'firered'
  | 'tts';

/** 各用途在「统一根目录」与「userData 默认」下共用的子路径段（design D2）。 */
export const STORAGE_SUBPATHS: Record<StorageKind, string[]> = {
  ggml: ['whisper-models'],
  ct2: ['faster-whisper-models'],
  funasr: ['models', 'funasr'],
  qwen: ['models', 'qwen'],
  firered: ['models', 'firered'],
  tts: ['models', 'tts'],
};

/** trim 判空语义对齐 modelImport.resolveOverridePath：空串/仅空白/undefined 视为未设置。 */
function normalized(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveStorageLocation(input: {
  /** 该用途的单独覆盖值（settings 中既有的 7 个路径键之一） */
  override?: string | null;
  /** settings.storageRoot */
  storageRoot?: string | null;
  /** 根目录（统一根或默认基座）下的子路径段 */
  subpath: string[];
  /** 默认基座（userData），由调用方传入以保持纯函数 */
  defaultBase: string;
}): ResolvedStorageLocation {
  const override = normalized(input.override);
  if (override.length > 0) {
    return { path: override, source: 'override' };
  }
  const storageRoot = normalized(input.storageRoot);
  if (storageRoot.length > 0) {
    return {
      path: path.join(storageRoot, ...input.subpath),
      source: 'storageRoot',
    };
  }
  return {
    path: path.join(input.defaultBase, ...input.subpath),
    source: 'default',
  };
}

/** settings 中与模型根目录解析相关的字段子集（结构化取用，避免依赖 StoreType）。 */
export interface StoragePathSettings {
  storageRoot?: string;
  modelsPath?: string;
  fasterWhisperModelsPath?: string;
  funasrModelsPath?: string;
  qwenModelsPath?: string;
  fireRedModelsPath?: string;
  ttsModelsPath?: string;
  useCustomTempDir?: boolean;
  customTempDir?: string;
}

const OVERRIDE_KEYS: Record<StorageKind, keyof StoragePathSettings> = {
  ggml: 'modelsPath',
  ct2: 'fasterWhisperModelsPath',
  funasr: 'funasrModelsPath',
  qwen: 'qwenModelsPath',
  firered: 'fireRedModelsPath',
  tts: 'ttsModelsPath',
};

/** 从 settings 对象解析某用途模型根目录（含来源）。 */
export function resolveModelRoot(
  kind: StorageKind,
  settings: StoragePathSettings | undefined | null,
  userDataPath: string,
): ResolvedStorageLocation {
  return resolveStorageLocation({
    override: settings?.[OVERRIDE_KEYS[kind]] as string | undefined,
    storageRoot: settings?.storageRoot,
    subpath: STORAGE_SUBPATHS[kind],
    defaultBase: userDataPath,
  });
}

/**
 * 临时目录三级解析（design D5）：
 *   useCustomTempDir && customTempDir > storageRoot/temp > 系统temp/whisper-subtitles
 * 注意默认级子目录名（whisper-subtitles）与统一根下的子目录名（temp）不同，
 * 故不复用 resolveStorageLocation。
 */
export function resolveTempDir(input: {
  useCustomTempDir?: boolean;
  customTempDir?: string | null;
  storageRoot?: string | null;
  /** 系统临时目录（app.getPath('temp')），由调用方传入以保持纯函数 */
  systemTempDir: string;
}): ResolvedStorageLocation {
  const custom = normalized(input.customTempDir);
  if (input.useCustomTempDir && custom.length > 0) {
    return { path: custom, source: 'override' };
  }
  const storageRoot = normalized(input.storageRoot);
  if (storageRoot.length > 0) {
    return { path: path.join(storageRoot, 'temp'), source: 'storageRoot' };
  }
  return {
    path: path.join(input.systemTempDir, 'whisper-subtitles'),
    source: 'default',
  };
}

/** settings 中所有存储路径键（CJK 兜底的作用范围，design D6-2）。 */
export const STORAGE_PATH_SETTING_KEYS = [
  'storageRoot',
  'modelsPath',
  'fasterWhisperModelsPath',
  'funasrModelsPath',
  'qwenModelsPath',
  'fireRedModelsPath',
  'ttsModelsPath',
  'customTempDir',
] as const;

/**
 * 主进程兜底：从 settings patch 中剔除含 CJK 字符的路径键。
 * 覆盖 setSettings IPC 与配置导入（configExporter）两条写入路径——
 * 渲染层选路校验是主执法，此处防旁路。
 */
export function sanitizeStoragePathPatch(
  patch: Record<string, unknown> | undefined | null,
): { sanitized: Record<string, unknown>; rejectedKeys: string[] } {
  const sanitized: Record<string, unknown> = { ...(patch ?? {}) };
  const rejectedKeys: string[] = [];
  for (const key of STORAGE_PATH_SETTING_KEYS) {
    const value = sanitized[key];
    if (typeof value === 'string' && containsCjk(value)) {
      delete sanitized[key];
      rejectedKeys.push(key);
    }
  }
  return { sanitized, rejectedKeys };
}

/**
 * 存量 modelsPath 归一化判定（design D4-2）：持久化值等于出厂默认
 * （userData/whisper-models）视为「未覆盖」，启动时删除该键使其参与统一目录跟随。
 */
export function isFactoryDefaultGgmlPath(
  modelsPath: string | undefined | null,
  userDataPath: string,
): boolean {
  const value = normalized(modelsPath);
  if (value.length === 0) return false;
  return value === path.join(userDataPath, ...STORAGE_SUBPATHS.ggml);
}
