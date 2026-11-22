import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { resolveStorageLocation } from '../storagePaths';
import { getGithubBase, getGithubProxyPrefix } from '../config/downloadConfig';

export type SpeakerDiarizationModelSource = 'ghproxy' | 'github';

export const SPEAKER_DIARIZATION_DEFAULT_SOURCE: SpeakerDiarizationModelSource =
  'ghproxy';
export const SPEAKER_DIARIZATION_PROGRESS_KEY = 'diarization:default';

export const SPEAKER_DIARIZATION_SEGMENTATION_ARCHIVE =
  'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
export const SPEAKER_DIARIZATION_EMBEDDING_FILE =
  '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
export const SPEAKER_DIARIZATION_SEGMENTATION_BYTES = 5_992_913;
// 上游在 2026-11-19 重新上传了 3D-Speaker 模型，文件比原来多 1 字节。
// 下载按当前上游的大小计算；校验时两个版本都接受，已经装好旧文件的用户不用重新下载。
export const SPEAKER_DIARIZATION_EMBEDDING_BYTES = 39_593_762;
const SPEAKER_DIARIZATION_EMBEDDING_ACCEPTED_BYTES: readonly number[] = [
  39_593_761,
  SPEAKER_DIARIZATION_EMBEDDING_BYTES,
];

export const SPEAKER_DIARIZATION_ASSETS = {
  segmentation: {
    releasePath:
      'k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models',
    fileName: SPEAKER_DIARIZATION_SEGMENTATION_ARCHIVE,
    downloadBytes: 6_958_444,
  },
  embedding: {
    // 上游 release tag 保留了 recongition 的历史拼写，不能修正。
    releasePath:
      'k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models',
    fileName: SPEAKER_DIARIZATION_EMBEDDING_FILE,
    downloadBytes: SPEAKER_DIARIZATION_EMBEDDING_BYTES,
  },
} as const;

export const SPEAKER_DIARIZATION_DOWNLOAD_BYTES =
  SPEAKER_DIARIZATION_ASSETS.segmentation.downloadBytes +
  SPEAKER_DIARIZATION_ASSETS.embedding.downloadBytes;

/** 统一存储根开启时落到 storageRoot/models/speaker-diarization。 */
export function getSpeakerDiarizationModelsRoot(): string {
  const { store } = require('../store') as typeof import('../store');
  const root = resolveStorageLocation({
    storageRoot: store.get('settings')?.storageRoot,
    subpath: ['models', 'speaker-diarization'],
    defaultBase: app.getPath('userData'),
  }).path;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getSpeakerDiarizationModelDir(): string {
  return path.join(getSpeakerDiarizationModelsRoot(), 'default');
}

export function getSpeakerDiarizationModelFiles(): {
  segmentation: string;
  embedding: string;
} {
  const root = getSpeakerDiarizationModelDir();
  return {
    segmentation: path.join(root, 'pyannote', 'model.onnx'),
    embedding: path.join(root, SPEAKER_DIARIZATION_EMBEDDING_FILE),
  };
}

export function validateSpeakerDiarizationModelDir(dir: string): {
  ok: boolean;
  missing: string[];
} {
  const expected = [
    {
      relative: path.join('pyannote', 'model.onnx'),
      acceptedBytes: [SPEAKER_DIARIZATION_SEGMENTATION_BYTES],
    },
    {
      relative: SPEAKER_DIARIZATION_EMBEDDING_FILE,
      acceptedBytes: SPEAKER_DIARIZATION_EMBEDDING_ACCEPTED_BYTES,
    },
  ];
  const missing = expected
    .filter(({ relative, acceptedBytes }) => {
      try {
        return !acceptedBytes.includes(
          fs.statSync(path.join(dir, relative)).size,
        );
      } catch {
        return true;
      }
    })
    .map(({ relative }) => relative);
  return { ok: missing.length === 0, missing };
}

export function isSpeakerDiarizationModelInstalled(): boolean {
  return validateSpeakerDiarizationModelDir(getSpeakerDiarizationModelDir()).ok;
}

export function deleteSpeakerDiarizationModel(): void {
  const dir = getSpeakerDiarizationModelDir();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function getSpeakerDiarizationAssetUrl(
  asset: keyof typeof SPEAKER_DIARIZATION_ASSETS,
  source: SpeakerDiarizationModelSource,
): string {
  const spec = SPEAKER_DIARIZATION_ASSETS[asset];
  const github = `${getGithubBase()}/${spec.releasePath}/${spec.fileName}`;
  return source === 'ghproxy' ? `${getGithubProxyPrefix()}/${github}` : github;
}

export function getSpeakerDiarizationSourceOrder(
  selected: SpeakerDiarizationModelSource,
): SpeakerDiarizationModelSource[] {
  return selected === 'github' ? ['github', 'ghproxy'] : ['ghproxy', 'github'];
}
