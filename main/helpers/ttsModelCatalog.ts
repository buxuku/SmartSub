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

/** TTS 模型标识（与本地子目录一一对应）。v1 = kokoro 多语 + vits-zh 中文补充；v2 + zipvoice 克隆。 */
export type TtsModelId =
  | 'kokoro-multi-lang-v1_1'
  | 'vits-zh-aishell3'
  | 'zipvoice-distill-zh-en';

export const TTS_DEFAULT_MODEL_ID: TtsModelId = 'kokoro-multi-lang-v1_1';

/**
 * TTS 模型下载源：kokoro/vits 无 ModelScope 镜像、HF 镜像 401（旧探索分支实测），
 * 只配 ghproxy → github 两级（design 决策 7）。
 */
export type TtsModelSource = 'ghproxy' | 'github';

export const TTS_DEFAULT_SOURCE: TtsModelSource = 'ghproxy';

const TTS_SOURCE_ORDER: TtsModelSource[] = ['ghproxy', 'github'];

export function getTtsSourceOrder(selected: TtsModelSource): TtsModelSource[] {
  return [selected, ...TTS_SOURCE_ORDER.filter((s) => s !== selected)];
}

/** 音色条目：sid = sherpa 内部说话人序号；id = 持久化用稳定标识（cue.voiceId / config.voice）。 */
export interface TtsVoice {
  id: string;
  sid: number;
  /** 中文展示名。 */
  label: string;
  /** 英文展示名。 */
  labelEn: string;
  lang: 'zh' | 'en';
  gender: 'f' | 'm';
}

/** 附加独立工件（整包之外的单文件，如 zipvoice 的 vocos vocoder 位于独立 release 路径）。 */
export interface TtsModelExtraFile {
  /** 落到模型目录的文件名（同时是 release 资产名）。 */
  name: string;
  /** GitHub release 路径（owner/repo/releases/download/tag）。 */
  releasePath: string;
}

export interface TtsModelSpec {
  id: TtsModelId;
  dirName: string;
  /** 展示名（模型卡片）。 */
  displayName: string;
  /** 语言范围（展示用）。 */
  languages: string[];
  /** 解包后安装体积（约）。 */
  approxInstallBytes: number;
  /** GitHub release 路径（owner/repo/releases/download/tag）。 */
  releasePath: string;
  archiveName: string;
  /** 解包后顶层目录名（decompress strip:1 去掉，记录用）。 */
  archiveInnerDir: string;
  /** 整包之外需单独下载的工件（随下载流程一并获取，计入安装判定）。 */
  extraFiles?: TtsModelExtraFile[];
  /** 判定「已安装」必须存在的关键文件（相对 dirName）。 */
  requiredFiles: string[];
  /** 输出采样率（展示/预估用）。 */
  sampleRate: number;
  defaultVoiceId: string;
  voices: TtsVoice[];
  /** 零样本克隆模型：无内置音色，voice 池 = 用户克隆音色（我的音色）。 */
  cloneOnly?: boolean;
  /** 模型目录 → worker 模型请求（布局单一来源，经旧探索分支实测验证）。 */
  buildModelRequest: (dir: string, numThreads?: number) => TtsModelRequest;
}

/**
 * kokoro v1.1 int8 多语模型的音色布局（103 音色，来源：旧探索分支实测 +
 * sherpa-onnx release 说明）：sid 0–2 英文女声（af_maple / af_sol 美音、bf_vale 英音），
 * 3–57 中文女声，58–102 中文男声。
 */
function kokoroVoices(): TtsVoice[] {
  const voices: TtsVoice[] = [
    {
      id: '0',
      sid: 0,
      label: '英文女声 Maple(美)',
      labelEn: 'English Female Maple (US)',
      lang: 'en',
      gender: 'f',
    },
    {
      id: '1',
      sid: 1,
      label: '英文女声 Sol(美)',
      labelEn: 'English Female Sol (US)',
      lang: 'en',
      gender: 'f',
    },
    {
      id: '2',
      sid: 2,
      label: '英文女声 Vale(英)',
      labelEn: 'English Female Vale (UK)',
      lang: 'en',
      gender: 'f',
    },
  ];
  for (let sid = 3; sid <= 57; sid++) {
    const n = String(sid - 2).padStart(2, '0');
    voices.push({
      id: String(sid),
      sid,
      label: `中文女声 ${n}`,
      labelEn: `Chinese Female ${n}`,
      lang: 'zh',
      gender: 'f',
    });
  }
  for (let sid = 58; sid <= 102; sid++) {
    const n = String(sid - 57).padStart(2, '0');
    voices.push({
      id: String(sid),
      sid,
      label: `中文男声 ${n}`,
      labelEn: `Chinese Male ${n}`,
      lang: 'zh',
      gender: 'm',
    });
  }
  return voices;
}

/** aishell3 174 说话人：无公开性别/名称表，统一编号展示（sid 即 speakers.txt 行序）。 */
function aishell3Voices(): TtsVoice[] {
  const voices: TtsVoice[] = [];
  for (let sid = 0; sid < 174; sid++) {
    const n = String(sid + 1).padStart(3, '0');
    voices.push({
      id: String(sid),
      sid,
      label: `中文说话人 ${n}`,
      labelEn: `Chinese Speaker ${n}`,
      lang: 'zh',
      gender: 'f',
    });
  }
  return voices;
}

const TTS_RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/tts-models';

export const TTS_MODELS: Record<TtsModelId, TtsModelSpec> = {
  'kokoro-multi-lang-v1_1': {
    id: 'kokoro-multi-lang-v1_1',
    dirName: 'kokoro-multi-lang-v1_1',
    displayName: 'Kokoro 多语 v1.1',
    languages: ['zh', 'en'],
    approxInstallBytes: 217_000_000,
    releasePath: TTS_RELEASE_PATH,
    archiveName: 'kokoro-int8-multi-lang-v1_1.tar.bz2',
    archiveInnerDir: 'kokoro-int8-multi-lang-v1_1',
    requiredFiles: [
      'model.int8.onnx',
      'voices.bin',
      'tokens.txt',
      'lexicon-us-en.txt',
      'lexicon-zh.txt',
      'espeak-ng-data/phontab',
    ],
    sampleRate: 24000,
    defaultVoiceId: '10',
    voices: kokoroVoices(),
    buildModelRequest: (dir, numThreads = 2) => ({
      modelType: 'kokoro',
      model: path.join(dir, 'model.int8.onnx'),
      voices: path.join(dir, 'voices.bin'),
      tokens: path.join(dir, 'tokens.txt'),
      dataDir: path.join(dir, 'espeak-ng-data'),
      // 中文走 lexicon-zh、英文走 lexicon-us-en，未命中回落 espeak-ng（实测可用配置）。
      lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
        .map((f) => path.join(dir, f))
        .join(','),
      ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
        .map((f) => path.join(dir, f))
        .join(','),
      numThreads,
    }),
  },
  'vits-zh-aishell3': {
    id: 'vits-zh-aishell3',
    dirName: 'vits-zh-aishell3',
    displayName: 'VITS 中文 AIShell3',
    languages: ['zh'],
    approxInstallBytes: 227_000_000,
    releasePath: TTS_RELEASE_PATH,
    archiveName: 'vits-icefall-zh-aishell3.tar.bz2',
    archiveInnerDir: 'vits-icefall-zh-aishell3',
    requiredFiles: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    sampleRate: 8000,
    defaultVoiceId: '0',
    voices: aishell3Voices(),
    buildModelRequest: (dir, numThreads = 2) => ({
      modelType: 'vits',
      model: path.join(dir, 'model.onnx'),
      tokens: path.join(dir, 'tokens.txt'),
      lexicon: path.join(dir, 'lexicon.txt'),
      ruleFsts: ['phone.fst', 'date.fst', 'number.fst']
        .map((f) => path.join(dir, f))
        .join(','),
      numThreads,
    }),
  },
  'zipvoice-distill-zh-en': {
    id: 'zipvoice-distill-zh-en',
    dirName: 'zipvoice-distill-zh-en',
    displayName: 'ZipVoice 声音克隆',
    languages: ['zh', 'en'],
    // 整包解包 ~163MB + vocoder 54MB。
    approxInstallBytes: 217_000_000,
    releasePath: TTS_RELEASE_PATH,
    archiveName: 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2',
    archiveInnerDir: 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
    // vocoder 位于独立 release 路径（vocoder-models），随下载流程一并获取。
    extraFiles: [
      {
        name: 'vocos_24khz.onnx',
        releasePath: 'k2-fsa/sherpa-onnx/releases/download/vocoder-models',
      },
    ],
    requiredFiles: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokens.txt',
      'lexicon.txt',
      'espeak-ng-data/phontab',
      'vocos_24khz.onnx',
    ],
    sampleRate: 24000,
    defaultVoiceId: '',
    voices: [],
    cloneOnly: true,
    buildModelRequest: (dir, numThreads = 2) => ({
      modelType: 'zipvoice',
      encoder: path.join(dir, 'encoder.int8.onnx'),
      decoder: path.join(dir, 'decoder.int8.onnx'),
      vocoder: path.join(dir, 'vocos_24khz.onnx'),
      tokens: path.join(dir, 'tokens.txt'),
      dataDir: path.join(dir, 'espeak-ng-data'),
      lexicon: path.join(dir, 'lexicon.txt'),
      numThreads,
    }),
  },
};

/** 附加工件下载 URL（ghproxy 前置 / github 直连，同整包源语义）。 */
export function getTtsExtraFileUrl(
  extra: TtsModelExtraFile,
  source: TtsModelSource,
): string {
  const github = `${getGithubBase()}/${extra.releasePath}/${extra.name}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

/** 整包下载 URL（ghproxy 前置 / github 直连）。 */
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

/** 全部 TTS 模型 id（静态，不触磁盘）。 */
export function getTtsModelIds(): TtsModelId[] {
  return Object.keys(TTS_MODELS) as TtsModelId[];
}

/** 已安装的 TTS 模型 id（触磁盘）。 */
export function getInstalledTtsModels(): TtsModelId[] {
  return getTtsModelIds().filter((id) => isTtsModelInstalled(id));
}

/** 组装某模型的 worker 模型请求（模型目录 + 布局 → TtsModelRequest）。 */
export function getTtsModelRequest(
  id: TtsModelId,
  numThreads?: number,
): TtsModelRequest {
  return TTS_MODELS[id].buildModelRequest(getTtsModelDir(id), numThreads);
}

/** voiceId → sherpa sid（未知 voice 回落模型默认音色）。纯查表。 */
export function resolveTtsVoiceSid(
  spec: TtsModelSpec,
  voiceId: string | undefined,
): number {
  const hit = spec.voices.find((v) => v.id === voiceId);
  if (hit) return hit.sid;
  const fallback = spec.voices.find((v) => v.id === spec.defaultVoiceId);
  return fallback?.sid ?? 0;
}

export function deleteTtsModel(id: TtsModelId): void {
  const dir = path.join(getTtsModelsRoot(), TTS_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
