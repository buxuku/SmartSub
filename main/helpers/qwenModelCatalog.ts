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

/** qwen 模型根目录：单独覆盖 > 统一存储目录 > userData/models/qwen */
export function getQwenModelsRoot(): string {
  const { store } = require('./store') as typeof import('./store');
  const root = resolveModelRoot(
    'qwen',
    store.get('settings'),
    app.getPath('userData'),
  ).path;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** qwen 子模型标识（与本地子目录一一对应）。P2 仅 0.6B。 */
export type QwenModelId = 'qwen3-asr-0.6b';

/** 默认（当前唯一）qwen 模型。 */
export const QWEN_DEFAULT_MODEL_ID: QwenModelId = 'qwen3-asr-0.6b';

/**
 * qwen 模型下载源：
 * - modelscope：ModelScope 国内仓库逐文件直下（国内 CDN 最快，且免解包）；
 * - ghproxy：GitHub release 整包经 gh-proxy.com 代理（国内加速）；
 * - github：GitHub release 整包直连（海外）。
 */
export type QwenModelSource = 'modelscope' | 'ghproxy' | 'github';

/** 默认下载源：国内优先 ModelScope。 */
export const QWEN_DEFAULT_SOURCE: QwenModelSource = 'modelscope';

/** 源回退规范顺序（国内优先）：modelscope → ghproxy → github。 */
const QWEN_SOURCE_ORDER: QwenModelSource[] = [
  'modelscope',
  'ghproxy',
  'github',
];

/** 所选源排第一，其余按规范顺序补齐，供下载失败时自动回退。 */
export function getQwenSourceOrder(
  selected: QwenModelSource,
): QwenModelSource[] {
  return [selected, ...QWEN_SOURCE_ORDER.filter((s) => s !== selected)];
}

/** ModelScope 逐文件映射：remote=仓库内路径，local=相对模型目录的落地路径。 */
export interface QwenModelScopeFile {
  remote: string;
  local: string;
}

/**
 * qwen 模型清单：支持两种获取方式——
 * - ModelScope 逐文件（modelScopeRepo + modelScopeFiles）：国内首选，免解包；
 * - GitHub release tar.bz2 整包（releasePath + archiveName）：经 gh-proxy / 直连回退，需解包。
 * sherpa-onnx Qwen3-ASR 四件套：conv_frontend / encoder / decoder + tokenizer 目录。
 */
export interface QwenModelSpec {
  id: QwenModelId;
  dirName: string;
  /** 体积/硬件提示用（解包后约 0.95GB；tar.bz2 下载包约 838MB）。 */
  approxInstallBytes: number;
  /** ModelScope 仓库 id（逐文件国内源）。 */
  modelScopeRepo: string;
  /** ModelScope 逐文件清单（remote→local）。 */
  modelScopeFiles: QwenModelScopeFile[];
  /** GitHub release 路径（owner/repo/releases/download/tag），用于整包源拼 URL。 */
  releasePath: string;
  /** release 整包文件名（tar.bz2）。 */
  archiveName: string;
  /** 解包后顶层目录名（用 decompress strip:1 去掉，此处仅作记录）。 */
  archiveInnerDir: string;
  /** 判定「已安装」必须存在的关键文件（相对 dirName）。 */
  requiredFiles: string[];
}

const QWEN_0_6B_ARCHIVE = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2';
const QWEN_0_6B_INNER = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';
const QWEN_0_6B_RELEASE_PATH =
  'k2-fsa/sherpa-onnx/releases/download/asr-models';
/** sherpa-onnx 的 Qwen3-ASR onnx 即源自该 ModelScope 仓库（k2-fsa 据此打包 tar.bz2）。 */
const QWEN_MS_REPO = 'zengshuishui/Qwen3-ASR-onnx';

export const QWEN_MODELS: Record<QwenModelId, QwenModelSpec> = {
  'qwen3-asr-0.6b': {
    id: 'qwen3-asr-0.6b',
    dirName: 'qwen3-asr-0.6b',
    approxInstallBytes: 1_020_000_000,
    modelScopeRepo: QWEN_MS_REPO,
    modelScopeFiles: [
      { remote: 'model_0.6B/conv_frontend.onnx', local: 'conv_frontend.onnx' },
      { remote: 'model_0.6B/encoder.int8.onnx', local: 'encoder.int8.onnx' },
      { remote: 'model_0.6B/decoder.int8.onnx', local: 'decoder.int8.onnx' },
      { remote: 'tokenizer/vocab.json', local: 'tokenizer/vocab.json' },
      { remote: 'tokenizer/merges.txt', local: 'tokenizer/merges.txt' },
      {
        remote: 'tokenizer/tokenizer_config.json',
        local: 'tokenizer/tokenizer_config.json',
      },
      { remote: 'tokenizer/config.json', local: 'tokenizer/config.json' },
      {
        remote: 'tokenizer/chat_template.json',
        local: 'tokenizer/chat_template.json',
      },
      {
        remote: 'tokenizer/preprocessor_config.json',
        local: 'tokenizer/preprocessor_config.json',
      },
    ],
    releasePath: QWEN_0_6B_RELEASE_PATH,
    archiveName: QWEN_0_6B_ARCHIVE,
    archiveInnerDir: QWEN_0_6B_INNER,
    // tokenizer 是目录；以其中两个关键文件作为安装完整性标记。
    requiredFiles: [
      'conv_frontend.onnx',
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokenizer/vocab.json',
      'tokenizer/merges.txt',
    ],
  },
};

/** 整包源（ghproxy/github）的 tar.bz2 下载 URL。 */
export function getQwenArchiveUrl(
  spec: QwenModelSpec,
  source: 'ghproxy' | 'github',
): string {
  const github = `${getGithubBase()}/${spec.releasePath}/${spec.archiveName}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

/** ModelScope 单文件 resolve 直链（302 跳国内 CDN，支持 Range）。 */
export function getQwenModelScopeFileUrl(
  spec: QwenModelSpec,
  remote: string,
): string {
  return `${getModelScopeBase()}/models/${spec.modelScopeRepo}/resolve/master/${remote}`;
}

/** ModelScope 文件树 API（取各文件 size 以计算总进度）。 */
export function getQwenModelScopeTreeUrl(spec: QwenModelSpec): string {
  return `${getModelScopeBase()}/api/v1/models/${spec.modelScopeRepo}/repo/files?Revision=master&Recursive=true`;
}

export function getQwenModelDir(id: QwenModelId): string {
  const dir = path.join(getQwenModelsRoot(), QWEN_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isQwenModelInstalled(id: QwenModelId): boolean {
  const dir = path.join(getQwenModelsRoot(), QWEN_MODELS[id].dirName);
  return QWEN_MODELS[id].requiredFiles.every((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/** 四件套绝对路径（供 adapter 注入 worker 模型请求；tokenizer 为目录）。 */
export function getQwenModelFiles(id: QwenModelId): {
  convFrontend: string;
  encoder: string;
  decoder: string;
  tokenizer: string;
} {
  const dir = getQwenModelDir(id);
  return {
    convFrontend: path.join(dir, 'conv_frontend.onnx'),
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    tokenizer: path.join(dir, 'tokenizer'),
  };
}

/** 共享 silero VAD：随应用内置（extraResources/sherpa/vad/silero_vad.onnx），与 funasr/fireRed 共用同一份。 */
export function getQwenVadModelPath(): string {
  const { getExtraResourcesPath } =
    require('./utils') as typeof import('./utils');
  return resolveBundledVadPath(getExtraResourcesPath());
}

/** 共享 VAD 是否就绪：检查随包内置文件是否存在（正常安装下恒为真）。 */
export function isQwenVadInstalled(): boolean {
  return fs.existsSync(getQwenVadModelPath());
}

/** 全部 qwen 模型 id（静态，纯函数，不触磁盘）。 */
export function getQwenModelIds(): QwenModelId[] {
  return Object.keys(QWEN_MODELS) as QwenModelId[];
}

/** 已安装的 qwen 模型 id（触磁盘）。 */
export function getInstalledQwenModels(): QwenModelId[] {
  return getQwenModelIds().filter((id) => isQwenModelInstalled(id));
}

/**
 * 选定要使用的 qwen 模型（纯函数）：
 * - requested 命中已装 → 用它；
 * - 否则回退首个已装；
 * - 无已装 → null。
 */
export function resolveQwenSelection(
  requested: string | undefined,
  installed: QwenModelId[],
): { id: QwenModelId } | null {
  if (installed.length === 0) return null;
  const ids = getQwenModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    ids.find((id) => id === normalized && installed.includes(id)) ??
    installed[0];
  return { id: chosen };
}

/** qwen 转写就绪 = 至少一个 qwen 模型 + 共享 silero VAD 均已安装。 */
export function isQwenReady(): boolean {
  return getInstalledQwenModels().length > 0 && isQwenVadInstalled();
}

export function deleteQwenModel(id: QwenModelId): void {
  const dir = path.join(getQwenModelsRoot(), QWEN_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
