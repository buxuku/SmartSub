import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveBundledVadPath } from './modelImport';
import { resolveModelRoot } from './storagePaths';
import { getGithubBase, getGithubProxyPrefix } from './config/downloadConfig';

/** Parakeet 模型根目录：单独覆盖 > 统一存储目录 > userData/models/parakeet */
export function getParakeetModelsRoot(): string {
  const { store } = require('./store') as typeof import('./store');
  const root = resolveModelRoot(
    'parakeet',
    store.get('settings'),
    app.getPath('userData'),
  ).path;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Parakeet 子模型标识（与本地子目录一一对应）。 */
export type ParakeetModelId = 'parakeet-tdt-0.6b-v3';

export const PARAKEET_DEFAULT_MODEL_ID: ParakeetModelId =
  'parakeet-tdt-0.6b-v3';

/** 官方 sherpa-onnx release 整包下载源。 */
export type ParakeetModelSource = 'ghproxy' | 'github';

/** 国内默认使用 GitHub 代理，失败时自动回退 GitHub。 */
export const PARAKEET_DEFAULT_SOURCE: ParakeetModelSource = 'ghproxy';

const PARAKEET_SOURCE_ORDER: ParakeetModelSource[] = ['ghproxy', 'github'];

export function getParakeetSourceOrder(
  selected: ParakeetModelSource,
): ParakeetModelSource[] {
  return [
    selected,
    ...PARAKEET_SOURCE_ORDER.filter((source) => source !== selected),
  ];
}

export interface ParakeetModelSpec {
  id: ParakeetModelId;
  dirName: string;
  upstreamModel: string;
  license: 'CC-BY-4.0';
  languageCount: number;
  supportsPunctuation: boolean;
  /** 解包后约 670MB；用于解包进度估算。 */
  approxInstallBytes: number;
  releasePath: string;
  archiveName: string;
  archiveInnerDir: string;
  requiredFiles: string[];
}

const PARAKEET_ARCHIVE = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2';
const PARAKEET_INNER = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const PARAKEET_RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/asr-models';

export const PARAKEET_MODELS: Record<ParakeetModelId, ParakeetModelSpec> = {
  'parakeet-tdt-0.6b-v3': {
    id: 'parakeet-tdt-0.6b-v3',
    dirName: 'parakeet-tdt-0.6b-v3',
    upstreamModel: 'nvidia/parakeet-tdt-0.6b-v3',
    license: 'CC-BY-4.0',
    languageCount: 25,
    supportsPunctuation: true,
    // encoder 652MB + decoder 11.8MB + joiner 6.36MB + tokens 94KB。
    approxInstallBytes: 671_000_000,
    releasePath: PARAKEET_RELEASE_PATH,
    archiveName: PARAKEET_ARCHIVE,
    archiveInnerDir: PARAKEET_INNER,
    requiredFiles: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ],
  },
};

export function getParakeetArchiveUrl(
  spec: ParakeetModelSpec,
  source: ParakeetModelSource,
): string {
  const github = `${getGithubBase()}/${spec.releasePath}/${spec.archiveName}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

export function getParakeetModelDir(id: ParakeetModelId): string {
  const dir = path.join(getParakeetModelsRoot(), PARAKEET_MODELS[id].dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isParakeetModelInstalled(id: ParakeetModelId): boolean {
  const dir = path.join(getParakeetModelsRoot(), PARAKEET_MODELS[id].dirName);
  return PARAKEET_MODELS[id].requiredFiles.every((file) =>
    fs.existsSync(path.join(dir, file)),
  );
}

/** NeMo transducer 三件套 + tokens 的绝对路径。 */
export function getParakeetModelFiles(id: ParakeetModelId): {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
} {
  const dir = getParakeetModelDir(id);
  return {
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    joiner: path.join(dir, 'joiner.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt'),
  };
}

/** 与其它本地 sherpa ASR 引擎共享随包内置的 Silero VAD。 */
export function getParakeetVadModelPath(): string {
  const { getExtraResourcesPath } =
    require('./utils') as typeof import('./utils');
  return resolveBundledVadPath(getExtraResourcesPath());
}

export function isParakeetVadInstalled(): boolean {
  return fs.existsSync(getParakeetVadModelPath());
}

export function getParakeetModelIds(): ParakeetModelId[] {
  return Object.keys(PARAKEET_MODELS) as ParakeetModelId[];
}

export function getInstalledParakeetModels(): ParakeetModelId[] {
  return getParakeetModelIds().filter((id) => isParakeetModelInstalled(id));
}

export function resolveParakeetSelection(
  requested: string | undefined,
  installed: ParakeetModelId[],
): { id: ParakeetModelId } | null {
  if (installed.length === 0) return null;
  const ids = getParakeetModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    ids.find((id) => id === normalized && installed.includes(id)) ??
    installed[0];
  return { id: chosen };
}

export function isParakeetReady(): boolean {
  return getInstalledParakeetModels().length > 0 && isParakeetVadInstalled();
}

export function deleteParakeetModel(id: ParakeetModelId): void {
  const dir = path.join(getParakeetModelsRoot(), PARAKEET_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
