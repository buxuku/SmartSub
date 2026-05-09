const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assertIncludes(content, needle, message) {
  if (!content.includes(needle)) {
    throw new Error(message);
  }
}

function assertMatches(content, pattern, message) {
  if (!pattern.test(content)) {
    throw new Error(message);
  }
}

const taskProcessor = read('main/helpers/taskProcessor.ts');
assertIncludes(
  taskProcessor,
  'processingTimer',
  'Task processor should coalesce queue polling timers to avoid duplicate completion/status events.',
);
assertIncludes(
  taskProcessor,
  'completeProcessingRun',
  'Task processor should send task completion through a guarded helper.',
);
assertIncludes(
  taskProcessor,
  'isCancellationRequested',
  'Task processor should expose cancellation state to per-file processing.',
);

const fileProcessor = read('main/helpers/fileProcessor.ts');
assertIncludes(
  fileProcessor,
  'throwIfCancelled',
  'File processor should stop between long stages after user cancellation.',
);

const audioProcessor = read('main/helpers/audioProcessor.ts');
assertIncludes(
  audioProcessor,
  "command.kill('SIGTERM')",
  'Audio extraction should actively stop ffmpeg when a task is cancelled.',
);

const transcriptionIndex = read('main/helpers/transcription/index.ts');
assertMatches(
  transcriptionIndex,
  /transcribeWithOpenRouter\([\s\S]*reportProgress[\s\S]*\);/,
  'OpenRouter transcription should receive a progress callback.',
);

const openRouter = read('main/helpers/transcription/openRouter.ts');
assertIncludes(
  openRouter,
  'onProgress?: (progress: number) => void',
  'OpenRouter adapter should expose chunk progress reporting.',
);
assertIncludes(
  openRouter,
  'Math.round(((index + 1) / chunks.length) * 85 + 10)',
  'OpenRouter adapter should report progress after each uploaded chunk.',
);
assertIncludes(
  openRouter,
  'throwIfOpenRouterCancelled',
  'OpenRouter adapter should stop between chunks when a task is cancelled.',
);

const addonDownloader = read('main/helpers/addonDownloader.ts');
assertIncludes(
  addonDownloader,
  'getAddonDownloadSourceStatus',
  'Addon downloader should expose source preflight status before starting downloads.',
);

const addonIpc = read('main/helpers/ipcAddonHandlers.ts');
assertIncludes(
  addonIpc,
  'get-addon-download-source-status',
  'Addon IPC should let the renderer query whether automatic addon downloads are configured.',
);
assertIncludes(
  addonIpc,
  'addon-download-progress',
  'Addon IPC should surface asynchronous download failures back to the renderer progress channel.',
);

const addonVersions = read('main/helpers/addonVersions.ts');
assertIncludes(
  addonVersions,
  'checkAllUpdatesResult',
  'Addon update checks should return structured failure details instead of looking like no updates.',
);

const gpuAccelerationCard = read(
  'renderer/components/settings/GpuAccelerationCard.tsx',
);
assertIncludes(
  gpuAccelerationCard,
  'addonDownloadSourceStatus',
  'GPU acceleration UI should know whether the selected addon download source is configured.',
);
assertIncludes(
  gpuAccelerationCard,
  'result?.success',
  'GPU acceleration UI should not toast download started unless IPC reports success.',
);

const subtitleGenerator = read('main/helpers/subtitleGenerator.ts');
assertIncludes(
  subtitleGenerator,
  'loadWhisperAddonRuntime',
  'Built-in Whisper should use runtime metadata instead of assuming GPU capability.',
);
assertIncludes(
  subtitleGenerator,
  'runtime.supportsGpu',
  'Built-in Whisper should pass use_gpu only when the loaded addon supports it.',
);
assertIncludes(
  subtitleGenerator,
  '转录结果为空，无法生成字幕',
  'Built-in Whisper should fail loudly instead of writing an empty SRT.',
);
assertIncludes(
  subtitleGenerator,
  'child.kill()',
  'Local Whisper command should be killed when a task is cancelled.',
);

const whisper = read('main/helpers/whisper.ts');
assertIncludes(
  whisper,
  'loadWhisperAddonRuntime',
  'Whisper helper should expose addon runtime metadata.',
);
assertIncludes(
  whisper,
  'supportsGpu',
  'Whisper addon runtime metadata should include GPU support.',
);
assertIncludes(
  whisper,
  'Falling back to default CPU addon',
  'Whisper addon loading should recover from broken CUDA/custom addon paths when possible.',
);

const srt = read('main/helpers/transcription/srt.ts');
assertIncludes(
  srt,
  'normalizeTranscriptionSegments',
  'Provider transcription SRT formatting should normalize segments before writing.',
);
assertIncludes(
  srt,
  'isLikelyDuplicateSegment',
  'Provider transcription SRT formatting should drop obvious repeated hallucinated segments.',
);

console.log('Upstream issue regression checks passed.');
