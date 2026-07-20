import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveBundledVadPath } from './modelImport';
import { resolveModelRoot } from './storagePaths';
import {
  getGithubBase,
  getGithubProxyPrefix,
  getModelScopeBase,
} from './config/downloadConfig';

/** fireRed 模型根目录：单独覆盖 > 统一存储目录 > userData/models/firered */
export function getFireRedModelsRoot(): string {
  const { store } = require('./store') as typeof import('./store');
  const root = resolveModelRoot(
    'firered',
    store.get('settings'),
    app.getPath('userData'),
  ).path;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** fireRed 子模型标识（与本地子目录一一对应）。本期仅 AED-L int8。 */
export type FireRedModelId = 'fire-red-asr-large-zh-en';

/** 默认（当前唯一）fireRed 模型。 */
export const FIRERED_DEFAULT_MODEL_ID: FireRedModelId =
  'fire-red-asr-large-zh-en';

/**
 * fireRed 模型下载源：
 * - modelscope：ModelScope 官方镜像逐文件直下（国内 CDN 最快，且免解包）；
 * - ghproxy：GitHub release 整包经 gh-proxy.com 代理（国内加速）；
 * - github：GitHub release 整包直连（海外）。
 */
export type FireRedModelSource = 'modelscope' | 'ghproxy' | 'github';

/** 默认下载源：国内优先 ModelScope（官方镜像存在）。 */
export const FIRERED_DEFAULT_SOURCE: FireRedModelSource = 'modelscope';

/** 源回退规范顺序（国内优先）：modelscope → ghproxy → github。 */
const FIRERED_SOURCE_ORDER: FireRedModelSource[] = [
  'modelscope',
  'ghproxy',
  'github',
];

/** 所选源排第一，其余按规范顺序补齐，供下载失败时自动回退。 */
export function getFireRedSourceOrder(
  selected: FireRedModelSource,
): FireRedModelSource[] {
  return [selected, ...FIRERED_SOURCE_ORDER.filter((s) => s !== selected)];
}

/** ModelScope 逐文件映射：remote=仓库内路径，local=相对模型目录的落地路径。 */
export interface FireRedModelScopeFile {
  remote: string;
  local: string;
}

/**
 * fireRed 模型清单：支持两种获取方式——
 * - ModelScope 逐文件（modelScopeRepo + modelScopeFiles）：国内首选，免解包；
 * - GitHub release tar.bz2 整包（releasePath + archiveName）：经 gh-proxy / 直连回退，需解包。
 * sherpa-onnx FireRedASR-AED 两件套：encoder.int8 / decoder.int8 + tokens.txt。
 */
export interface FireRedModelSpec {
  id: FireRedModelId;
  dirName: string;
  /** 体积/硬件提示用（解包后约 1.74GB；tar.bz2 下载包约 1.4GB）。 */
  approxInstallBytes: number;
  /** ModelScope 仓库 id（逐文件国内源，官方镜像）。 */
  modelScopeRepo: string;
  /** ModelScope 逐文件清单（remote→local）。 */
  modelScopeFiles: FireRedModelScopeFile[];
  /** GitHub release 路径（owner/repo/releases/download/tag），用于整包源拼 URL。 */
  releasePath: string;
  /** release 整包文件名（tar.bz2）。 */
  archiveName: string;
  /** 解包后顶层目录名（用 decompress strip:1 去掉，此处仅作记录）。 */
  archiveInnerDir: string;
  /** 判定「已安装」必须存在的关键文件（相对 dirName）。 */
  requiredFiles: string[];
}

const FIRERED_ARCHIVE =
  'sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16.tar.bz2';
const FIRERED_INNER = 'sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16';
const FIRERED_RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/asr-models';
/** sherpa-onnx 的 FireRedASR onnx 官方镜像（与 HF csukuangfj 同作者同内容）。 */
const FIRERED_MS_REPO =
  'csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16';

export const FIRERED_MODELS: Record<FireRedModelId, FireRedModelSpec> = {
  'fire-red-asr-large-zh-en': {
    id: 'fire-red-asr-large-zh-en',
    dirName: 'fire-red-asr-large-zh-en',
    // encoder 1.29GB + decoder 425MB + tokens 70KB ≈ 1.74GB（实测字节累加）。
    approxInstallBytes: 1_740_000_000,
    modelScopeRepo: FIRERED_MS_REPO,
    // ModelScope 仓库内文件平铺在根（经文件树 API 核实）。
    modelScopeFiles: [
      { remote: 'encoder.int8.onnx', local: 'encoder.int8.onnx' },
      { remote: 'decoder.int8.onnx', local: 'decoder.int8.onnx' },
      { remote: 'tokens.txt', local: 'tokens.txt' },
    ],
    releasePath: FIRERED_RELEASE_PATH,
    archiveName: FIRERED_ARCHIVE,
    archiveInnerDir: FIRERED_INNER,
    requiredFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
  },
};

/** 整包源（ghproxy/github）的 tar.bz2 下载 URL。 */
export function getFireRedArchiveUrl(
  spec: FireRedModelSpec,
  source: 'ghproxy' | 'github',
): string {
  const github = `${getGithubBase()}/${spec.releasePath}/${spec.archiveName}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

/** ModelScope 单文件 resolve 直链（302 跳国内 CDN，支持 Range）。 */
export function getFireRedModelScopeFileUrl(
  spec: FireRedModelSpec,
  remote: string,
): string {
  return `${getModelScopeBase()}/models/${spec.modelScopeRepo}/resolve/master/${remote}`;
}

/** ModelScope 文件树 API（取各文件 size 以计算总进度）。 */
export function getFireRedModelScopeTreeUrl(spec: FireRedModelSpec): string {
  return `${getModelScopeBase()}/api/v1/models/${spec.modelScopeRepo}/repo/files?Revision=master&Recursive=true`;
}

export function getFireRedModelDir(id: FireRedModelId): string {
  const dir = path.join(getFireRedModelsRoot(), FIRERED_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isFireRedModelInstalled(id: FireRedModelId): boolean {
  const dir = path.join(getFireRedModelsRoot(), FIRERED_MODELS[id].dirName);
  return FIRERED_MODELS[id].requiredFiles.every((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/** 两件套 + tokens 绝对路径（供 adapter 注入 worker 模型请求）。 */
export function getFireRedModelFiles(id: FireRedModelId): {
  encoder: string;
  decoder: string;
  tokens: string;
} {
  const dir = getFireRedModelDir(id);
  return {
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt'),
  };
}

/** 共享 silero VAD：随应用内置（extraResources/sherpa/vad/silero_vad.onnx），与 funasr/qwen 共用同一份。 */
export function getFireRedVadModelPath(): string {
  const { getExtraResourcesPath } =
    require('./utils') as typeof import('./utils');
  return resolveBundledVadPath(getExtraResourcesPath());
}

/** 共享 VAD 是否就绪：检查随包内置文件是否存在（正常安装下恒为真）。 */
export function isFireRedVadInstalled(): boolean {
  return fs.existsSync(getFireRedVadModelPath());
}

/** 全部 fireRed 模型 id（静态，纯函数，不触磁盘）。 */
export function getFireRedModelIds(): FireRedModelId[] {
  return Object.keys(FIRERED_MODELS) as FireRedModelId[];
}

/** 已安装的 fireRed 模型 id（触磁盘）。 */
export function getInstalledFireRedModels(): FireRedModelId[] {
  return getFireRedModelIds().filter((id) => isFireRedModelInstalled(id));
}

/**
 * 选定要使用的 fireRed 模型（纯函数）：
 * - requested 命中已装 → 用它；
 * - 否则回退首个已装；
 * - 无已装 → null。
 */
export function resolveFireRedSelection(
  requested: string | undefined,
  installed: FireRedModelId[],
): { id: FireRedModelId } | null {
  if (installed.length === 0) return null;
  const ids = getFireRedModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    ids.find((id) => id === normalized && installed.includes(id)) ??
    installed[0];
  return { id: chosen };
}

/** fireRed 转写就绪 = 至少一个 fireRed 模型 + 共享 silero VAD 均已安装。 */
export function isFireRedReady(): boolean {
  return getInstalledFireRedModels().length > 0 && isFireRedVadInstalled();
}

export function deleteFireRedModel(id: FireRedModelId): void {
  const dir = path.join(getFireRedModelsRoot(), FIRERED_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
