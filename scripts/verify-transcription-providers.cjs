const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(file, needle, message) {
  assert(file.includes(needle), message);
}

function assertNotIncludes(file, needle, message) {
  assert(!file.includes(needle), message);
}

function assertFile(relativePath, message) {
  assert(fs.existsSync(path.join(root, relativePath)), message);
}

assertFile(
  'types/transcription.ts',
  'Shared transcription provider types should exist.',
);

const transcriptionTypes = read('types/transcription.ts');
assertIncludes(
  transcriptionTypes,
  "'openrouter'",
  'OpenRouter should be a first-class transcription provider.',
);
assertIncludes(
  transcriptionTypes,
  "'reazonspeech-k2'",
  'ReazonSpeech K2 should be a first-class transcription provider.',
);
assertIncludes(
  transcriptionTypes,
  'openai/gpt-4o-transcribe',
  'OpenRouter GPT-4o Transcribe model should be in the catalog.',
);
assertIncludes(
  transcriptionTypes,
  'reazonspeech-k2-v2',
  'ReazonSpeech K2 v2 model should be in the catalog.',
);

assertFile(
  'main/helpers/transcription/index.ts',
  'Main transcription dispatch module should exist.',
);
assertFile(
  'main/helpers/transcription/openRouter.ts',
  'OpenRouter transcription adapter should exist.',
);
assertFile(
  'main/helpers/transcription/reazonSpeech.ts',
  'ReazonSpeech K2 transcription adapter should exist.',
);
assertFile(
  'main/helpers/transcription/srt.ts',
  'Shared SRT formatting helpers should exist.',
);

const openRouter = read('main/helpers/transcription/openRouter.ts');
assertIncludes(
  openRouter,
  'https://openrouter.ai/api/v1/audio/transcriptions',
  'OpenRouter adapter should use the official transcription endpoint.',
);
assertIncludes(
  openRouter,
  'input_audio',
  'OpenRouter adapter should send base64 input_audio.',
);
assertIncludes(
  openRouter,
  'openai/gpt-4o-transcribe',
  'OpenRouter adapter should default to GPT-4o Transcribe.',
);
assertIncludes(
  openRouter,
  'OPENROUTER_TRANSCRIPTION_MODELS_ENDPOINT',
  'OpenRouter adapter should expose the STT model discovery endpoint.',
);
assertIncludes(
  openRouter,
  'output_modalities=transcription',
  'OpenRouter model discovery should be scoped to transcription models.',
);
assertIncludes(
  openRouter,
  'splitAudioForOpenRouter',
  'OpenRouter adapter should split long audio before upload.',
);
assertIncludes(
  openRouter,
  'OPENROUTER_STT_MAX_CHUNK_SECONDS',
  'OpenRouter adapter should encode a provider timeout-aware chunk size.',
);
assertIncludes(
  openRouter,
  'makeApproximateSegments',
  'OpenRouter adapter should build chunk-offset subtitle segments instead of a single whole-file estimate.',
);
assertIncludes(
  openRouter,
  'redactOpenRouterSecrets',
  'OpenRouter adapter should redact provider errors before surfacing them.',
);
assertIncludes(
  openRouter,
  'X-Generation-Id',
  'OpenRouter adapter should preserve generation ids in error/debug context.',
);

const reazon = read('main/helpers/transcription/reazonSpeech.ts');
assertIncludes(
  reazon,
  'reazonspeech.k2.asr',
  'Reazon adapter should use the official ReazonSpeech K2 Python interface.',
);
assertIncludes(
  reazon,
  'sherpa_onnx.OfflineRecognizer.from_transducer',
  'Reazon adapter should load SmartSub-downloaded ONNX files directly.',
);
assertIncludes(
  reazon,
  'encoder-epoch-99-avg-1.int8.onnx',
  'Reazon adapter should support the official int8 K2 v2 file layout.',
);
assertIncludes(
  reazon,
  'reazonspeech-k2-v2',
  'Reazon adapter should require the K2 v2 model.',
);
assertIncludes(
  reazon,
  'REAZON_K2_MAX_SEGMENT_SECONDS',
  'Reazon adapter should encode the official short-segment constraint.',
);
assertIncludes(
  reazon,
  'ensureReazonSpeechRuntimeReady',
  'Reazon adapter should preflight Python package readiness before transcription.',
);
assertIncludes(
  reazon,
  'importlib.import_module',
  'Reazon preflight should verify required Python modules are importable.',
);
assertIncludes(
  reazon,
  'offsetSeconds',
  'Reazon segment offsets should be based on actual chunk duration.',
);

const subtitleGenerator = read('main/helpers/fileProcessor.ts');
assertIncludes(
  subtitleGenerator,
  'generateSubtitleWithTranscriptionProvider',
  'Subtitle generation should dispatch through the transcription provider framework.',
);

const modelDownloader = read('main/helpers/modelDownloader.ts');
assertIncludes(
  modelDownloader,
  'downloadReazonSpeechModel',
  'Model downloader should support ReazonSpeech model downloads.',
);
assertIncludes(
  modelDownloader,
  'reazonspeech-k2-v2',
  'Model downloader should know the ReazonSpeech K2 v2 model id.',
);

const taskConfig = read('renderer/components/TaskConfigForm.tsx');
assertIncludes(
  taskConfig,
  'transcriptionProvider',
  'Task config should let users choose a transcription provider.',
);
assertIncludes(
  taskConfig,
  'getTranscriptionModelOptions',
  'Task config should filter models by transcription provider.',
);

const systemInfoManager = read('main/helpers/systemInfoManager.ts');
assertIncludes(
  systemInfoManager,
  'getOpenRouterTranscriptionModels',
  'Main process should expose OpenRouter transcription model discovery over IPC.',
);
assertIncludes(
  systemInfoManager,
  'fetchOpenRouterTranscriptionModels',
  'OpenRouter IPC handler should use the adapter model discovery function.',
);

const modelsComponent = read('renderer/components/Models.tsx');
assertIncludes(
  modelsComponent,
  'openRouterRemoteModels',
  'OpenRouter model selector should merge remote model discovery results.',
);
assertIncludes(
  modelsComponent,
  'getOpenRouterTranscriptionModels',
  'OpenRouter model selector should call the model discovery IPC handler.',
);
assertNotIncludes(
  modelsComponent,
  '[...modelMap.values()]',
  'OpenRouter model selector should avoid iterator spread because this project targets ES5.',
);

const settings = read('renderer/pages/[locale]/settings.tsx');
assertIncludes(
  settings,
  'openRouterApiKey',
  'Settings UI should expose OpenRouter API key for transcription.',
);

console.log('Transcription provider checks passed.');
