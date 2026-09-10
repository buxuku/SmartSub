import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveBundledVadPath, validateModelLayout } from './modelImport';
import { resolveModelRoot } from './storagePaths';
import { getGithubBase, getGithubProxyPrefix } from './config/downloadConfig';
import {
  PARAKEET_MODEL_DEFINITIONS,
  PARAKEET_MODEL_IDS,
  type ParakeetModelDefinition,
  type ParakeetModelId,
} from '../../types/parakeet';

export {
  PARAKEET_DEFAULT_MODEL_ID,
  resolveParakeetSelection,
  type ParakeetModelId,
} from '../../types/parakeet';

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

export interface ParakeetModelSpec extends ParakeetModelDefinition {
  id: ParakeetModelId;
  dirName: string;
  upstreamModel: string;
  languageCount: number;
  /** 用于解包进度估算。 */
  approxInstallBytes: number;
  releasePath: string;
  archiveName: string;
  archiveInnerDir: string;
  requiredFiles: string[];
}

const PARAKEET_RELEASE_PATH = 'k2-fsa/sherpa-onnx/releases/download/asr-models';

export const PARAKEET_MODELS: Record<ParakeetModelId, ParakeetModelSpec> = {
  'parakeet-tdt-0.6b-v3': {
    ...PARAKEET_MODEL_DEFINITIONS['parakeet-tdt-0.6b-v3'],
    id: 'parakeet-tdt-0.6b-v3',
    dirName: 'parakeet-tdt-0.6b-v3',
    upstreamModel: 'nvidia/parakeet-tdt-0.6b-v3',
    languageCount: 25,
    // encoder 652MB + decoder 11.8MB + joiner 6.36MB + tokens 94KB。
    approxInstallBytes: 671_000_000,
    releasePath: PARAKEET_RELEASE_PATH,
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    archiveInnerDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    requiredFiles: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ],
  },
  'parakeet-tdt-0.6b-v2': {
    ...PARAKEET_MODEL_DEFINITIONS['parakeet-tdt-0.6b-v2'],
    id: 'parakeet-tdt-0.6b-v2',
    dirName: 'parakeet-tdt-0.6b-v2',
    upstreamModel: 'nvidia/parakeet-tdt-0.6b-v2',
    languageCount: 1,
    approxInstallBytes: 662_000_000,
    releasePath: PARAKEET_RELEASE_PATH,
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    archiveInnerDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    requiredFiles: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ],
  },
  'parakeet-tdt_ctc-0.6b-ja': {
    ...PARAKEET_MODEL_DEFINITIONS['parakeet-tdt_ctc-0.6b-ja'],
    id: 'parakeet-tdt_ctc-0.6b-ja',
    dirName: 'parakeet-tdt_ctc-0.6b-ja',
    upstreamModel: 'nvidia/parakeet-tdt_ctc-0.6b-ja',
    languageCount: 1,
    approxInstallBytes: 656_000_000,
    releasePath: PARAKEET_RELEASE_PATH,
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8.tar.bz2',
    archiveInnerDir: 'sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8',
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
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
  return validateModelLayout(dir, PARAKEET_MODELS[id].requiredFiles).ok;
}

export type ParakeetModelFiles =
  | {
      modelType: 'nemo_transducer';
      encoder: string;
      decoder: string;
      joiner: string;
      tokens: string;
    }
  | { modelType: 'nemo_ctc'; asrModel: string; tokens: string };

export function getParakeetModelFiles(id: ParakeetModelId): ParakeetModelFiles {
  const dir = getParakeetModelDir(id);
  const tokens = path.join(dir, 'tokens.txt');
  if (PARAKEET_MODELS[id].modelType === 'nemo_ctc') {
    return {
      modelType: 'nemo_ctc',
      asrModel: path.join(dir, 'model.int8.onnx'),
      tokens,
    };
  }
  return {
    modelType: 'nemo_transducer',
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    joiner: path.join(dir, 'joiner.int8.onnx'),
    tokens,
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
  return [...PARAKEET_MODEL_IDS];
}

export function getInstalledParakeetModels(): ParakeetModelId[] {
  return getParakeetModelIds().filter((id) => isParakeetModelInstalled(id));
}

export function isParakeetReady(): boolean {
  return getInstalledParakeetModels().length > 0 && isParakeetVadInstalled();
}

export function deleteParakeetModel(id: ParakeetModelId): void {
  const dir = path.join(getParakeetModelsRoot(), PARAKEET_MODELS[id].dirName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
