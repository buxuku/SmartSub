'use strict';

// validateSpeakerDiarizationModelDir 按文件大小判断模型是否完整。
// 上游重新上传过 3D-Speaker 模型（多 1 字节），新旧两个版本都必须通过校验，
// 否则新下载的模型装不上，或者已经装好的旧模型被判成缺失。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/speakerDiarization/modelCatalog.ts')) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
    if (request === '../storagePaths') return {};
    if (request === '../config/downloadConfig') return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  SPEAKER_DIARIZATION_ASSETS,
  SPEAKER_DIARIZATION_EMBEDDING_BYTES,
  SPEAKER_DIARIZATION_EMBEDDING_FILE,
  SPEAKER_DIARIZATION_SEGMENTATION_BYTES,
  validateSpeakerDiarizationModelDir,
} = require('../main/helpers/speakerDiarization/modelCatalog.ts');

const ORIGINAL_EMBEDDING_BYTES = 39_593_761;
const REUPLOADED_EMBEDDING_BYTES = 39_593_762;
const segmentationFile = path.join('pyannote', 'model.onnx');

// 只需要文件大小，用 truncate 生成稀疏文件即可。
function modelDir(root, name, sizes) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'pyannote'), { recursive: true });
  if (sizes.segmentation !== undefined) {
    const file = path.join(dir, segmentationFile);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, sizes.segmentation);
  }
  if (sizes.embedding !== undefined) {
    const file = path.join(dir, SPEAKER_DIARIZATION_EMBEDDING_FILE);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, sizes.embedding);
  }
  return dir;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-diarization-'));
try {
  // 下载进度和下载后的校验都以当前上游的文件大小为准。
  assert.equal(SPEAKER_DIARIZATION_EMBEDDING_BYTES, REUPLOADED_EMBEDDING_BYTES);
  assert.equal(
    SPEAKER_DIARIZATION_ASSETS.embedding.downloadBytes,
    REUPLOADED_EMBEDDING_BYTES,
  );

  assert.deepEqual(
    validateSpeakerDiarizationModelDir(
      modelDir(root, 'reuploaded', {
        segmentation: SPEAKER_DIARIZATION_SEGMENTATION_BYTES,
        embedding: REUPLOADED_EMBEDDING_BYTES,
      }),
    ),
    { ok: true, missing: [] },
    '当前上游的模型文件应通过校验',
  );
  assert.deepEqual(
    validateSpeakerDiarizationModelDir(
      modelDir(root, 'original', {
        segmentation: SPEAKER_DIARIZATION_SEGMENTATION_BYTES,
        embedding: ORIGINAL_EMBEDDING_BYTES,
      }),
    ),
    { ok: true, missing: [] },
    '重新上传之前安装的模型文件仍应通过校验',
  );
  assert.deepEqual(
    validateSpeakerDiarizationModelDir(
      modelDir(root, 'truncated-embedding', {
        segmentation: SPEAKER_DIARIZATION_SEGMENTATION_BYTES,
        embedding: ORIGINAL_EMBEDDING_BYTES - 1,
      }),
    ),
    { ok: false, missing: [SPEAKER_DIARIZATION_EMBEDDING_FILE] },
    '不完整的声纹模型应被拒绝',
  );
  assert.deepEqual(
    validateSpeakerDiarizationModelDir(
      modelDir(root, 'oversized-embedding', {
        segmentation: SPEAKER_DIARIZATION_SEGMENTATION_BYTES,
        embedding: REUPLOADED_EMBEDDING_BYTES + 1,
      }),
    ),
    { ok: false, missing: [SPEAKER_DIARIZATION_EMBEDDING_FILE] },
    '大小不在已知版本内的声纹模型应被拒绝',
  );
  assert.deepEqual(
    validateSpeakerDiarizationModelDir(
      modelDir(root, 'truncated-segmentation', {
        segmentation: SPEAKER_DIARIZATION_SEGMENTATION_BYTES - 1,
        embedding: REUPLOADED_EMBEDDING_BYTES,
      }),
    ),
    { ok: false, missing: [segmentationFile] },
    '不完整的分割模型应被拒绝',
  );
  assert.deepEqual(
    validateSpeakerDiarizationModelDir(modelDir(root, 'empty', {})),
    {
      ok: false,
      missing: [segmentationFile, SPEAKER_DIARIZATION_EMBEDDING_FILE],
    },
    '文件缺失时应全部报告',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  Module._load = originalLoad;
  if (originalTs) require.extensions['.ts'] = originalTs;
  else delete require.extensions['.ts'];
}

console.log('✓ speaker diarization model validation tests passed (8)');
