import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import {
  getFunasrModelDir,
  isFunasrModelInstalled,
} from './funasrModelCatalog';

/** qwen 模型根目录：userData/models/qwen */
export function getQwenModelsRoot(): string {
  const root = path.join(app.getPath('userData'), 'models', 'qwen');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** qwen 子模型标识（与本地子目录一一对应）。P2 仅 0.6B。 */
export type QwenModelId = 'qwen3-asr-0.6b';

/** 默认（当前唯一）qwen 模型。 */
export const QWEN_DEFAULT_MODEL_ID: QwenModelId = 'qwen3-asr-0.6b';

/**
 * qwen 模型清单：通过 k2-fsa 的 GitHub release tar.bz2 整包下载后解包到本地目录。
 * sherpa-onnx Qwen3-ASR 四件套：conv_frontend / encoder / decoder + tokenizer 目录。
 */
export interface QwenModelSpec {
  id: QwenModelId;
  dirName: string;
  /** 体积/硬件提示用（解包后约 0.95GB；下载包约 838MB）。 */
  approxInstallBytes: number;
  /** release 整包文件名（tar.bz2）。 */
  archiveName: string;
  /** 解包后顶层目录名（用 decompress strip:1 去掉，此处仅作记录）。 */
  archiveInnerDir: string;
  /** 整包候选下载 URL（按序回退；ghproxy 优先国内）。 */
  archiveUrls: string[];
  /** 判定「已安装」必须存在的关键文件（相对 dirName）。 */
  requiredFiles: string[];
}

const QWEN_0_6B_ARCHIVE = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2';
const QWEN_0_6B_INNER = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';
const QWEN_0_6B_RELEASE_PATH =
  'k2-fsa/sherpa-onnx/releases/download/asr-models';

export const QWEN_MODELS: Record<QwenModelId, QwenModelSpec> = {
  'qwen3-asr-0.6b': {
    id: 'qwen3-asr-0.6b',
    dirName: 'qwen3-asr-0.6b',
    approxInstallBytes: 1_020_000_000,
    archiveName: QWEN_0_6B_ARCHIVE,
    archiveInnerDir: QWEN_0_6B_INNER,
    archiveUrls: [
      `https://ghfast.top/https://github.com/${QWEN_0_6B_RELEASE_PATH}/${QWEN_0_6B_ARCHIVE}`,
      `https://github.com/${QWEN_0_6B_RELEASE_PATH}/${QWEN_0_6B_ARCHIVE}`,
    ],
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

/** 共享 silero VAD（复用 funasr 已下载的 VAD，避免重复下载）。 */
export function getQwenVadModelPath(): string {
  return path.join(getFunasrModelDir('silero-vad'), 'silero_vad.onnx');
}

/** silero VAD 是否就绪（qwen 与 funasr 共用同一 VAD 文件）。 */
export function isQwenVadInstalled(): boolean {
  return isFunasrModelInstalled('silero-vad');
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
