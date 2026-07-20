import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getDownloadEndpoints } from './config/downloadConfig';
import { resolveBundledVadPath } from './modelImport';
import { resolveModelRoot } from './storagePaths';

/** funasr 模型根目录：单独覆盖 > 统一存储目录 > userData/models/funasr */
export function getFunasrModelsRoot(): string {
  const { store } = require('./store') as typeof import('./store');
  const root = resolveModelRoot(
    'funasr',
    store.get('settings'),
    app.getPath('userData'),
  ).path;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** funasr 子模型标识（与本地子目录一一对应）。 */
export type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

/** ASR 模型底层类型，决定 sidecar 走 from_sense_voice / from_paraformer。 */
export type FunasrModelType = 'sense_voice' | 'paraformer';

/**
 * 两种下载模式：
 * - repo：从 HF（镜像）仓库按 tree 下载子集（keepFiles）。
 * - files：按显式候选 URL 顺序回退下单个文件（silero 这类 release 资产）。
 */
export interface FunasrModelSpec {
  id: FunasrModelId;
  dirName: string;
  /** 'asr' 进入模型下拉并参与转写；'vad' 为共用基础组件，不进下拉。 */
  kind: 'asr' | 'vad';
  /** ASR 模型的底层加载类型（kind==='asr' 时必填）。 */
  modelType?: FunasrModelType;
  /** 判定「已安装」必须存在的关键文件 */
  requiredFiles: string[];
  /** HF（镜像）仓库 id（repo 模式） */
  repo?: string;
  /** 仅保留这些文件，省带宽（repo 模式；缺省下载全部非点文件） */
  keepFiles?: string[];
  /**
   * files 模式的待下载文件列表（按 name 逐个下载）。
   * 候选 URL 由 getFunasrFileUrls() 在运行时按可配置端点生成；
   * urls 仅作为可选的静态兜底（一般留空）。
   */
  files?: { name: string; urls?: string[] }[];
}

export const FUNASR_MODELS: Record<FunasrModelId, FunasrModelSpec> = {
  'sensevoice-small': {
    id: 'sensevoice-small',
    dirName: 'sensevoice-small',
    kind: 'asr',
    modelType: 'sense_voice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    keepFiles: ['model.int8.onnx', 'tokens.txt'],
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
  'paraformer-zh': {
    id: 'paraformer-zh',
    dirName: 'paraformer-zh',
    kind: 'asr',
    modelType: 'paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09',
    keepFiles: ['model.int8.onnx', 'tokens.txt'],
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
  // 【已退役/随包内置】VAD 现随应用发布（extraResources/sherpa/vad/silero_vad.onnx），
  // 运行时一律走 getFunasrVadModelPath()/isFunasrVadInstalled()，不再下载。
  // 此条目仅作为兼容旧版「曾下载到 funasr 根」的遗留元数据保留，UI 不再暴露下载入口。
  'silero-vad': {
    id: 'silero-vad',
    dirName: 'silero-vad',
    kind: 'vad',
    requiredFiles: ['silero_vad.onnx'],
    // 候选 URL 在运行时由 getFunasrFileUrls() 按可配置端点生成（镜像/代理可在设置页覆盖）。
    files: [{ name: 'silero_vad.onnx' }],
  },
};

/**
 * files 模式下单个文件的运行时候选下载 URL（按序回退）。
 * 镜像 / 代理 / GitHub base 均取自可配置的下载端点，用户在设置页改完即时生效。
 */
export function getFunasrFileUrls(
  id: FunasrModelId,
  fileName: string,
): string[] {
  if (id === 'silero-vad' && fileName === 'silero_vad.onnx') {
    const ep = getDownloadEndpoints();
    const ghRelease = `${ep.githubBase}/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`;
    return [
      `${ep.huggingFaceMirror}/csukuangfj/vad/resolve/main/silero_vad.onnx`,
      ghRelease,
      `${ep.githubProxyPrefix}/${ghRelease}`,
      `${ep.huggingFaceOfficial}/csukuangfj/vad/resolve/main/silero_vad.onnx`,
    ];
  }
  return [];
}

export function getFunasrModelDir(id: FunasrModelId): string {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isFunasrModelInstalled(id: FunasrModelId): boolean {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  return FUNASR_MODELS[id].requiredFiles.every((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/**
 * 共享 silero VAD 的绝对路径：随应用内置（extraResources/sherpa/vad/silero_vad.onnx），
 * 不再依赖下载。funasr / qwen / fireRedAsr 共用这一份，与各引擎可自定义的模型根目录解耦。
 */
export function getFunasrVadModelPath(): string {
  const { getExtraResourcesPath } =
    require('./utils') as typeof import('./utils');
  return resolveBundledVadPath(getExtraResourcesPath());
}

/** 共享 VAD 是否就绪：检查随包内置文件是否存在（正常安装下恒为真）。 */
export function isFunasrVadInstalled(): boolean {
  return fs.existsSync(getFunasrVadModelPath());
}

/** 全部 ASR 模型 id（静态，纯函数，不触磁盘）。 */
export function getFunasrAsrModelIds(): FunasrModelId[] {
  return (Object.keys(FUNASR_MODELS) as FunasrModelId[]).filter(
    (id) => FUNASR_MODELS[id].kind === 'asr',
  );
}

/** 已安装的 ASR 模型 id（触磁盘）。 */
export function getInstalledFunasrAsrModels(): FunasrModelId[] {
  return getFunasrAsrModelIds().filter((id) => isFunasrModelInstalled(id));
}

/**
 * 选定要使用的 ASR 模型（纯函数）：
 * - requested 命中已装 ASR → 用它；
 * - 否则回退首个已装 ASR；
 * - 无已装 ASR → null。
 */
export function resolveFunasrAsrSelection(
  requested: string | undefined,
  installedAsr: FunasrModelId[],
): { id: FunasrModelId; modelType: FunasrModelType } | null {
  if (installedAsr.length === 0) return null;
  const asrIds = getFunasrAsrModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    asrIds.find((id) => id === normalized && installedAsr.includes(id)) ??
    installedAsr[0];
  return {
    id: chosen,
    modelType: FUNASR_MODELS[chosen].modelType ?? 'sense_voice',
  };
}

/** funasr 转写就绪 = 内置 VAD + 至少一个 ASR 模型已安装。 */
export function isFunasrReady(): boolean {
  return isFunasrVadInstalled() && getInstalledFunasrAsrModels().length > 0;
}

export function deleteFunasrModel(id: FunasrModelId): void {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
