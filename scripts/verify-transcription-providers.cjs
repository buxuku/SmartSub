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
  'openai/gpt-4o-transcribe',
  'OpenRouter GPT-4o Transcribe model should be in the catalog.',
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
  'main/helpers/transcription/srt.ts',
  'Shared SRT formatting helpers should exist.',
);

const openRouter = read('main/helpers/transcription/openRouter.ts');
assertIncludes(
  openRouter,
  'https://openrouter.ai/api/v1/audio/transcriptions',
  'OpenRouter adapter should use the official STT transcription endpoint.',
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
  'OpenRouter model discovery should query transcription-capable models.',
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
  'silencedetect',
  'OpenRouter adapter should split audio on detected silence instead of fixed-time cuts only.',
);
assertIncludes(
  openRouter,
  'speechWindows',
  'OpenRouter adapter should use speech windows to refine subtitle timing inside chunks.',
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

const subtitleGenerator = read('main/helpers/fileProcessor.ts');
assertIncludes(
  subtitleGenerator,
  'generateSubtitleWithTranscriptionProvider',
  'Subtitle generation should dispatch through the transcription provider framework.',
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
const removedProviderStem = 'rea' + 'zonSpeech';
assertNotIncludes(
  settings,
  removedProviderStem,
  'Settings UI should no longer expose removed local provider settings.',
);

const userConfig = read('main/helpers/userConfig.ts');
assertIncludes(
  userConfig,
  'normalizeTranscriptionProvider',
  'User config should normalize removed or unknown transcription providers.',
);
assertIncludes(
  userConfig,
  'resetRemovedTranscriptionModel',
  'User config should reset removed transcription model ids during migration.',
);

const transcriptionIndex = read('main/helpers/transcription/index.ts');
assertIncludes(
  transcriptionIndex,
  'normalizeTranscriptionProvider',
  'Transcription execution should guard against stale removed provider ids.',
);

console.log('Transcription provider checks passed.');
