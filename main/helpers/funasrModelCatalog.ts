import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/** funasr 模型根目录：userData/models/funasr */
export function getFunasrModelsRoot(): string {
  const root = path.join(app.getPath('userData'), 'models', 'funasr');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** funasr 子模型标识（与本地子目录一一对应）。 */
export type FunasrModelId = 'sensevoice-small' | 'silero-vad';

/**
 * 两种下载模式：
 * - repo：从 HF（镜像）仓库按 tree 下载子集（keepFiles）。
 * - files：按显式候选 URL 顺序回退下单个文件（silero 这类 release 资产）。
 */
export interface FunasrModelSpec {
  id: FunasrModelId;
  dirName: string;
  /** 判定「已安装」必须存在的关键文件 */
  requiredFiles: string[];
  /** HF（镜像）仓库 id（repo 模式） */
  repo?: string;
  /** 仅保留这些文件，省带宽（repo 模式；缺省下载全部非点文件） */
  keepFiles?: string[];
  /** 单文件候选 URL（files 模式，按序回退） */
  files?: { name: string; urls: string[] }[];
}

export const FUNASR_MODELS: Record<FunasrModelId, FunasrModelSpec> = {
  'sensevoice-small': {
    id: 'sensevoice-small',
    dirName: 'sensevoice-small',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    keepFiles: ['model.int8.onnx', 'tokens.txt'],
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
  'silero-vad': {
    id: 'silero-vad',
    dirName: 'silero-vad',
    requiredFiles: ['silero_vad.onnx'],
    files: [
      {
        name: 'silero_vad.onnx',
        urls: [
          'https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx',
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
          'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
          'https://huggingface.co/csukuangfj/vad/resolve/main/silero_vad.onnx',
        ],
      },
    ],
  },
};

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

/** funasr 转写就绪 = ASR + VAD 两个模型都已安装。 */
export function isFunasrReady(): boolean {
  return (
    isFunasrModelInstalled('sensevoice-small') &&
    isFunasrModelInstalled('silero-vad')
  );
}

export function deleteFunasrModel(id: FunasrModelId): void {
  const dir = path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
