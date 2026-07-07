import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveOverridePath } from './modelImport';
import { getGithubBase, getGithubProxyPrefix } from './config/downloadConfig';
import type { TtsModelRequest } from './sherpaOnnx/ttsRuntime';

/** TTS 模型根目录：settings.ttsModelsPath 覆盖，否则 userData/models/tts */
export function getTtsModelsRoot(): string {
  const { store } = require('./store') as typeof import('./store');
  const fallback = path.join(app.getPath('userData'), 'models', 'tts');
  const root = resolveOverridePath(
    store.get('settings')?.ttsModelsPath,
    fallback,
  );
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** TTS 子模型标识（与本地子目录一一对应）。 */
export type TtsModelId = 'kokoro-multi-lang-v1_1' | 'vits-zh-aishell3';

/** 默认推荐模型：Kokoro（24kHz、中英混合、103 音色）。 */
export const TTS_DEFAULT_MODEL_ID: TtsModelId = 'kokoro-multi-lang-v1_1';

/** 各模型默认试听/配音音色 sid（与 renderer/lib/ttsVoices.ts 一致）。 */
export const TTS_DEFAULT_VOICE_SID: Record<TtsModelId, number> = {
  'kokoro-multi-lang-v1_1': 3,
  'vits-zh-aishell3': 0,
};

/**
 * TTS 模型下载源（探测结论 2026-07：ModelScope 无这两个模型的镜像仓库，
 * HF 镜像 aishell3 返回 401——均不可用；整包 tar.bz2 走 GitHub release）：
 * - ghproxy：GitHub release 经 gh-proxy.com 代理（国内加速，实测支持 Range）；
 * - github：GitHub release 直连（海外）。
 */
export type TtsModelSource = 'ghproxy' | 'github';

/** 默认下载源：国内优先走代理。 */
export const TTS_DEFAULT_SOURCE: TtsModelSource = 'ghproxy';

/** 源回退规范顺序：ghproxy → github。 */
const TTS_SOURCE_ORDER: TtsModelSource[] = ['ghproxy', 'github'];

/** 所选源排第一，其余按规范顺序补齐，供下载失败时自动回退。 */
export function getTtsSourceOrder(selected: TtsModelSource): TtsModelSource[] {
  return [selected, ...TTS_SOURCE_ORDER.filter((s) => s !== selected)];
}

/**
 * TTS 模型清单：GitHub release tar.bz2 整包（releasePath + archiveName），
 * 解包用 extractArchive（strip:1 去顶层目录）。文件布局经冒烟脚本实测核实。
 */
export interface TtsModelSpec {
  id: TtsModelId;
  dirName: string;
  /** worker buildTtsConfig 的模型家族分支。 */
  modelFamily: 'kokoro' | 'vits';
  /** UI 展示用静态元数据（与模型包实测一致）。 */
  meta: {
    numSpeakers: number;
    sampleRate: number;
    /** 支持语言（BCP-47 主标签）。 */
    languages: string[];
  };
  /** 解包后目录实测大小（du 实测字节，用于磁盘提示与解包进度估算）。 */
  approxInstallBytes: number;
  /** release 整包大小（字节，约值，用于下载进度兜底）。 */
  approxArchiveBytes: number;
  /** GitHub release 路径（owner/repo/releases/download/tag）。 */
  releasePath: string;
  /** release 整包文件名（tar.bz2）。 */
  archiveName: string;
  /** 解包后顶层目录名（extractArchive strip:1 剥掉，此处仅作记录）。 */
  archiveInnerDir: string;
  /** 判定「已安装」必须存在的关键文件/目录（相对 dirName）。 */
  requiredFiles: string[];
}

const TTS_RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/tts-models';

export const TTS_MODELS: Record<TtsModelId, TtsModelSpec> = {
  'kokoro-multi-lang-v1_1': {
    id: 'kokoro-multi-lang-v1_1',
    dirName: 'kokoro-multi-lang-v1_1',
    modelFamily: 'kokoro',
    meta: {
      numSpeakers: 103,
      sampleRate: 24000,
      languages: ['zh', 'en'],
    },
    // du 实测 215,548 KB；tar.bz2 约 147MB。
    approxInstallBytes: 220_721_152,
    approxArchiveBytes: 154_140_672,
    releasePath: TTS_RELEASE_PATH,
    archiveName: 'kokoro-int8-multi-lang-v1_1.tar.bz2',
    archiveInnerDir: 'kokoro-int8-multi-lang-v1_1',
    requiredFiles: [
      'model.int8.onnx',
      'voices.bin',
      'tokens.txt',
      'espeak-ng-data',
      'lexicon-us-en.txt',
      'lexicon-zh.txt',
    ],
  },
  'vits-zh-aishell3': {
    id: 'vits-zh-aishell3',
    dirName: 'vits-zh-aishell3',
    modelFamily: 'vits',
    meta: {
      numSpeakers: 174,
      sampleRate: 8000,
      languages: ['zh'],
    },
    // du 实测 208,492 KB；tar.bz2 约 116MB。
    approxInstallBytes: 213_495_808,
    approxArchiveBytes: 121_634_816,
    releasePath: TTS_RELEASE_PATH,
    archiveName: 'vits-icefall-zh-aishell3.tar.bz2',
    archiveInnerDir: 'vits-icefall-zh-aishell3',
    requiredFiles: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
  },
};

/** 整包源的 tar.bz2 下载 URL。 */
export function getTtsArchiveUrl(
  spec: TtsModelSpec,
  source: TtsModelSource,
): string {
  const github = `${getGithubBase()}/${spec.releasePath}/${spec.archiveName}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

export function getTtsModelDir(id: TtsModelId): string {
  const dir = path.join(getTtsModelsRoot(), TTS_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isTtsModelInstalled(id: TtsModelId): boolean {
  const dir = path.join(getTtsModelsRoot(), TTS_MODELS[id].dirName);
  return TTS_MODELS[id].requiredFiles.every((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/**
 * 组装 worker 模型请求（绝对路径拼好）。文件布局与冒烟脚本一致：
 * - kokoro：中英双词典 + espeak-ng-data 回落 + 中文归一化 fst；
 * - vits(aishell3)：单词典 + 中文归一化 fst。
 */
export function getTtsModelRequest(
  id: TtsModelId,
  numThreads?: number,
): TtsModelRequest {
  const spec = TTS_MODELS[id];
  const dir = getTtsModelDir(id);
  if (spec.modelFamily === 'kokoro') {
    return {
      modelFamily: 'kokoro',
      files: {
        model: path.join(dir, 'model.int8.onnx'),
        tokens: path.join(dir, 'tokens.txt'),
        voices: path.join(dir, 'voices.bin'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
          .map((f) => path.join(dir, f))
          .join(','),
        ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
          .map((f) => path.join(dir, f))
          .filter((f) => fs.existsSync(f))
          .join(','),
      },
      numThreads,
    };
  }
  return {
    modelFamily: 'vits',
    files: {
      model: path.join(dir, 'model.onnx'),
      tokens: path.join(dir, 'tokens.txt'),
      lexicon: path.join(dir, 'lexicon.txt'),
      ruleFsts: ['phone.fst', 'date.fst', 'number.fst']
        .map((f) => path.join(dir, f))
        .filter((f) => fs.existsSync(f))
        .join(','),
    },
    numThreads,
  };
}

/** 全部 TTS 模型 id（静态，纯函数，不触磁盘）。 */
export function getTtsModelIds(): TtsModelId[] {
  return Object.keys(TTS_MODELS) as TtsModelId[];
}

/** 已安装的 TTS 模型 id（触磁盘）。 */
export function getInstalledTtsModels(): TtsModelId[] {
  return getTtsModelIds().filter((id) => isTtsModelInstalled(id));
}

/**
 * 选定要使用的 TTS 模型（纯函数）：
 * - requested 命中已装 → 用它；
 * - 否则回退默认模型（若已装）；
 * - 再回退首个已装；无已装 → null。
 */
export function resolveTtsSelection(
  requested: string | undefined,
  installed: TtsModelId[],
): { id: TtsModelId } | null {
  if (installed.length === 0) return null;
  const ids = getTtsModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    ids.find((id) => id === normalized && installed.includes(id)) ??
    (installed.includes(TTS_DEFAULT_MODEL_ID)
      ? TTS_DEFAULT_MODEL_ID
      : installed[0]);
  return { id: chosen };
}

/** 本地 TTS 就绪 = 至少一个模型已安装（原生库随包内置，无额外依赖）。 */
export function isTtsReady(): boolean {
  return getInstalledTtsModels().length > 0;
}

export function deleteTtsModel(id: TtsModelId): void {
  const dir = path.join(getTtsModelsRoot(), TTS_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
