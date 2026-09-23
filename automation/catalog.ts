import { z } from 'zod';
import {
  file,
  mediaConfigs,
  composeConfig,
  dubbingConfig,
  pipelineConfig,
  syncConfig,
  downloadConfig,
} from './schemas';

const str = z.string().min(1);
const object = z.record(z.unknown());
const id = { id: str };
const config = object.describe(
  'Advanced SmartSub configuration. See the linked operation reference for the corresponding application type.',
);
export interface OperationDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  readOnly: boolean;
  long?: boolean;
  channel?: string;
  argument?: string;
  cancelChannel?: string;
}
export const operations: OperationDefinition[] = [];
function add(
  name: string,
  description: string,
  shape: z.ZodRawShape = {},
  opts: Partial<OperationDefinition> = {},
) {
  operations.push({
    name,
    description,
    schema: z.object(shape).strict(),
    readOnly: false,
    ...opts,
  });
}
function read(
  name: string,
  description: string,
  shape: z.ZodRawShape = {},
  channel?: string,
  argument?: string,
) {
  add(name, description, shape, { readOnly: true, channel, argument });
}
function mapped(
  name: string,
  description: string,
  channel: string,
  shape: z.ZodRawShape,
  opts: Partial<OperationDefinition> = {},
) {
  add(name, description, shape, { channel, ...opts });
}
const requestId = str
  .max(128)
  .optional()
  .describe(
    'Reuse only to retry the same submission without running it twice.',
  );
const engine = z.enum([
  'builtin',
  'fasterWhisper',
  'funasr',
  'qwen',
  'fireRedAsr',
  'parakeet',
  'localCli',
  'cloud',
]);
const modelEngine = z.enum([
  'builtin',
  'fasterWhisper',
  'funasr',
  'qwen',
  'fireRedAsr',
  'parakeet',
  'tts',
  'speakerDiarization',
]);
const providerKind = z.enum(['translation', 'asr', 'tts']);
const subtitleFormat = z.enum(['srt', 'vtt', 'ass', 'lrc', 'txt']);
const pipeline = {
  files: z.array(file).min(1).max(1000),
  engine: engine.optional(),
  model: str.optional(),
  sourceLanguage: str.optional(),
  targetLanguage: str.optional(),
  providerId: str.optional(),
  outputDir: file
    .optional()
    .describe(
      'Defaults to a new directory per task under the profile automation outputs directory.',
    ),
  name: str.optional(),
  requestId,
  config: pipelineConfig
    .optional()
    .describe(
      'Advanced IFormData overrides: dub, compose, gates, transcription parameters, glossary and refinement settings.',
    ),
};
read(
  'system.info',
  'Application version, platform, profile, installed models, providers and automation health.',
);
read(
  'system.capabilities',
  'List all operations and whether they are read-only or asynchronous.',
);
read(
  'system.logs',
  'Read redacted application logs.',
  {
    projectId: str.optional(),
    date: str.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  },
  'getLogs',
);
read(
  'system.languages',
  'Supported language codes.',
  {},
  'getSupportedLanguages',
);
read(
  'system.sample',
  'Absolute path of the bundled sample audio.',
  {},
  'getOnboardingSamplePath',
);
read('tasks.list', 'List recent desktop and automation jobs.', {
  limit: z.number().int().min(1).max(200).default(50),
});
read(
  'tasks.get',
  'Get status, progress, error, result and output paths. Poll until a terminal status.',
  id,
);
read(
  'tasks.wait',
  'Wait up to 25 seconds for a terminal or review state. Timeout never cancels a job.',
  { ...id, timeoutMs: z.number().int().min(0).max(25000).default(25000) },
);
add(
  'tasks.cancel',
  'Cancel only the specified job and its active child process.',
  id,
);
add(
  'tasks.pause',
  'Pause dispatch of additional files in a pipeline; active files may finish.',
  id,
);
add('tasks.resume', 'Resume a paused pipeline.', id);
add(
  'tasks.retry',
  'Retry interrupted or failed pipeline files using the saved execution settings.',
  { ...id, requestId },
);
add(
  'tasks.delete',
  'Delete a completed task record; does not delete input media.',
  id,
);
add(
  'transcribe',
  'Transcribe audio/video using an installed local engine or explicitly selected cloud provider. Returns a job ID.',
  pipeline,
  { long: true },
);
add(
  'translate',
  'Translate subtitle files using a configured translation provider. Returns a job ID.',
  { ...pipeline, targetLanguage: str },
  { long: true },
);
add(
  'pipeline.run',
  'Run transcription/translation with optional dubbing and video composition. Default review gates are automatic.',
  {
    ...pipeline,
    taskType: z
      .enum(['generateOnly', 'translateOnly', 'generateAndTranslate'])
      .default('generateAndTranslate'),
  },
  { long: true },
);
mapped(
  'pipeline.release',
  'Release a subtitle or dubbing review gate.',
  'pipeline:releaseGate',
  {
    projectId: str,
    gate: z.enum(['subtitle', 'dubbing']),
    fileUuids: z.array(str).optional(),
  },
);
read(
  'subtitles.read',
  'Read subtitle cues with a content version for safe editing. Paginated; times are milliseconds.',
  {
    filePath: file,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  },
);
add(
  'subtitles.write',
  'Write subtitle cues to a new file. In-place changes require overwrite=true and the version returned by subtitles.read.',
  {
    filePath: file,
    cues: z
      .array(
        z.object({
          startMs: z.number().min(0),
          endMs: z.number().min(0),
          text: z.string(),
        }),
      )
      .min(1),
    format: subtitleFormat.optional(),
    overwrite: z.boolean().default(false),
    expectedVersion: str.optional(),
  },
);
read(
  'subtitles.validate',
  'Validate a subtitle file.',
  { filePath: file },
  'validateSubtitleFile',
);
read(
  'subtitles.detect-language',
  'Detect subtitle language.',
  { filePath: file },
  'detectLanguage',
);
read(
  'subtitles.scan',
  'Find subtitle/media pairs in a local directory.',
  { directoryPath: file, strict: z.boolean().optional() },
  'smartScanDirectory',
);
read(
  'subtitles.encoding',
  'Detect subtitle character encoding.',
  { filePath: file },
  'toolbox:detectEncoding',
  'filePath',
);
mapped(
  'subtitles.convert',
  'Convert subtitle format, encoding and Chinese script without overwriting input.',
  'toolbox:convertSubtitleFile',
  {
    filePath: file,
    targetFormat: subtitleFormat,
    outputDir: file.optional(),
    sourceEncoding: str.optional(),
    targetEncoding: z.enum(['utf-8', 'utf-8-bom', 'gb18030']).optional(),
    chineseConversion: z
      .enum(['none', 's2t', 't2s', 's2tw', 'tw2s', 's2hk', 'hk2s'])
      .optional(),
    cleanFormatting: z.boolean().optional(),
    includeTimestampsInTxt: z.boolean().optional(),
    requestId,
  },
  { long: true },
);
mapped(
  'subtitles.sync',
  'Shift or rescale subtitle timings.',
  'toolbox:syncSubtitleTime',
  {
    filePath: file,
    offsetMs: z.number().optional(),
    config: syncConfig.default({}),
  },
  { long: true },
);
mapped(
  'subtitles.merge',
  'Merge primary and secondary subtitle files into bilingual subtitles.',
  'toolbox:mergeBilingualSubtitles',
  {
    primaryPath: file,
    secondaryPath: file,
    config: z
      .object({
        primaryPosition: z.enum(['top', 'bottom']).default('top'),
        separator: z.string().optional(),
        outputPath: file.optional(),
      })
      .strict()
      .default({}),
  },
  { long: true },
);
mapped(
  'subtitles.split',
  'Split bilingual subtitles.',
  'toolbox:splitBilingualSubtitles',
  {
    filePath: file,
    config: z.object({ outputDir: file.optional() }).strict().default({}),
  },
  { long: true },
);
mapped(
  'subtitles.optimize',
  'Polish one source or translated subtitle using a configured AI provider.',
  'optimizeSubtitle',
  {
    sourceText: z.string(),
    targetText: z.string().default(''),
    providerId: str,
    mode: z.enum(['source', 'translation']).default('translation'),
    sourceLanguage: str.optional(),
    targetLanguage: str.optional(),
    customPrompt: str.optional(),
    intent: z.enum(['polish', 'correct', 'shorten']).optional(),
    requestId,
  },
  { long: true },
);
mapped(
  'subtitles.retranslate',
  'Retranslate subtitle rows using an existing provider. Results are returned in the job result.',
  'retranslateSubtitles',
  {
    subtitles: z.array(
      z.object({ id: str, startEndTime: str, content: z.array(z.string()) }),
    ),
    providerId: str,
    sourceLanguage: str,
    targetLanguage: str,
    requestId,
  },
  { long: true },
);
read(
  'proofread.read',
  'Read canonical proofread data including speakers and translations.',
  { filePath: file },
  'readProofreadDataFile',
);
add(
  'proofread.save',
  'Save canonical proofread rows, speakers and rendered subtitles with conflict checking.',
  {
    filePath: file,
    expectedVersion: str,
    subtitles: z.array(object),
    speakers: z.array(object).default([]),
    outputs: z
      .array(z.object({ filePath: file, contentType: str.optional() }))
      .default([]),
    embedSpeakerNames: z.boolean().default(false),
  },
);
read(
  'media.probe',
  'Inspect media duration, dimensions, streams and codecs.',
  { filePath: file },
  'toolbox:getVideoInfo',
  'filePath',
);
read(
  'media.subtitles',
  'List embedded subtitle tracks.',
  { filePath: file },
  'toolbox:scanEmbeddedSubtitles',
  'filePath',
);
const mediaOperations = [
  [
    'trim',
    'Trim a video. config: startSec,endSec,mode (lossless|accurate),outputPath/outputDir.',
    'trimVideo',
    'cancelTrimVideo',
  ],
  [
    'extract-audio',
    'Extract audio. config: format (mp3|wav|aac|m4a|flac),bitrate,wavPreset,outputPath.',
    'extractAudio',
    'cancelExtractAudio',
  ],
  [
    'compress',
    'Compress video. Use the VideoCompressConfig fields.',
    'compressVideo',
    'cancelCompressVideo',
  ],
  [
    'gif',
    'Convert video to GIF. Use the VideoToGifConfig fields.',
    'videoToGif',
    'cancelVideoToGif',
  ],
] as const;
for (const [name, description, channel, cancel] of mediaOperations)
  mapped(
    `media.${name}`,
    description,
    `toolbox:${channel}`,
    { filePath: file, config: mediaConfigs[name], requestId },
    { long: true, cancelChannel: `toolbox:${cancel}` },
  );
mapped(
  'media.extract-subtitles',
  'Extract embedded text subtitles to files.',
  'toolbox:extractEmbeddedSubtitles',
  {
    videoPath: file,
    streamIndices: z.array(z.number().int().min(0)).min(1),
    targetFormat: z.enum(['srt', 'ass', 'vtt']),
    outputDir: file.optional(),
    requestId,
  },
  { long: true, cancelChannel: 'toolbox:cancelEmbeddedSubtitles' },
);
mapped(
  'compose.run',
  'Burn or mux subtitles into video. config uses MergeConfig: outputMode hardcode/softmux, style, videoQuality, encoderMode and optional audioTrack.',
  'subtitleMerge:startMerge',
  {
    videoPath: file,
    subtitlePath: file,
    outputPath: file.optional(),
    config: composeConfig.default({}),
    requestId,
  },
  { long: true, cancelChannel: 'subtitleMerge:cancelMerge' },
);
read(
  'compose.queue',
  'Inspect the shared video composition queue.',
  {},
  'subtitleMerge:getQueue',
);
read(
  'compose.encoders',
  'Available hardware video encoders.',
  {},
  'subtitleMerge:getHwAccelInfo',
);
read(
  'compose.fonts',
  'Installed fonts for subtitle composition.',
  {},
  'subtitleMerge:listFonts',
);
read(
  'compose.presets',
  'List subtitle style presets.',
  {},
  'subtitleMerge:listStylePresets',
);
mapped(
  'compose.save-preset',
  'Save a subtitle style preset.',
  'subtitleMerge:saveStylePreset',
  { preset: config },
  { argument: 'preset' },
);
mapped(
  'compose.delete-preset',
  'Delete a subtitle style preset.',
  'subtitleMerge:deleteStylePreset',
  id,
  { argument: 'id' },
);
read('providers.list', 'List configured providers without secret values.', {
  kind: providerKind.optional(),
});
read(
  'providers.types',
  'Discover provider types, supported capabilities and configuration fields before creating an instance.',
  { kind: providerKind.optional() },
);
add(
  'providers.save',
  'Create or patch a provider by ID. Omitted credentials are preserved; secrets are write-only.',
  { kind: providerKind, provider: object },
);
add('providers.delete', 'Delete one configured provider by ID.', {
  kind: providerKind,
  ...id,
});
add(
  'providers.test',
  'Test a configured provider connection; may make a billable request.',
  { kind: providerKind, ...id },
  { long: true },
);
read(
  'providers.health',
  'Cached service health; does not send network requests.',
  {},
  'getProviderHealth',
);
read('settings.get', 'Read redacted application settings and task defaults.');
add(
  'settings.update',
  'Patch validated application settings; preserves omitted fields.',
  { settings: object },
);
read(
  'models.list',
  'List installed ASR, TTS and speaker models and runtime status.',
);
add(
  'models.install',
  'Download a catalog model; returns a job ID.',
  {
    engine: modelEngine,
    model: str.optional(),
    source: str.default('huggingface'),
    needsCoreML: z.boolean().default(false),
    requestId,
  },
  { long: true },
);
add(
  'models.delete',
  'Delete a model only while transcription and synthesis are idle.',
  { engine: modelEngine, model: str.optional() },
);
mapped(
  'models.import',
  'Import a local model file or directory with existing layout validation.',
  'importModel',
  {
    engine: modelEngine.exclude(['speakerDiarization']),
    modelId: str.optional(),
    sourcePath: file,
  },
  { long: true },
);
read('engines.list', 'List ASR engine availability.', {}, 'get-engine-status');
mapped(
  'engines.install',
  'Install the faster-whisper runtime. Poll engines.progress until installation ends.',
  'start-py-engine-download',
  {
    source: str.default('github'),
    variant: z.enum(['cpu', 'cuda']).optional(),
  },
);
read(
  'engines.progress',
  'Runtime installation progress.',
  {},
  'get-py-engine-download-progress',
);
mapped(
  'engines.cancel',
  'Cancel runtime installation.',
  'cancel-py-engine-download',
  {},
);
mapped(
  'engines.remove',
  'Remove faster-whisper runtime when idle.',
  'uninstall-py-engine',
  {},
);
mapped(
  'engines.import',
  'Import a faster-whisper runtime archive.',
  'import-py-engine',
  { sourcePath: file },
  { long: true },
);
read(
  'tts.voices',
  'List voices for a configured cloud TTS provider or installed local models.',
  { providerId: str.optional() },
);
add(
  'tts.synthesize',
  'Synthesize text to an audio file with a configured cloud TTS provider or local model.',
  {
    text: str,
    providerId: str.optional(),
    model: str.optional(),
    voice: str,
    language: str.default('en'),
    outputPath: file.optional(),
    requestId,
  },
  { long: true },
);
const session = { sessionId: str };
read(
  'dubbing.get',
  'Read a persisted dubbing session.',
  session,
  'dubbing:getSession',
);
mapped(
  'dubbing.create',
  'Create a dubbing session from subtitles and optional media.',
  'dubbing:loadSubtitle',
  {
    subtitlePath: file,
    videoPath: file.optional(),
    proofreadDataFile: file.optional(),
  },
);
mapped(
  'dubbing.run',
  'Synthesize all or stale subtitle cues. config uses DubbingConfig.',
  'dubbing:start',
  {
    ...session,
    config: dubbingConfig,
    force: z.boolean().optional(),
    staleOnly: z.boolean().optional(),
    speakerId: z.number().int().optional(),
    requestId,
  },
  { long: true, cancelChannel: 'dubbing:cancel' },
);
mapped(
  'dubbing.export',
  'Export the synthesized track or dubbed video using DubbingConfig.',
  'dubbing:export',
  { ...session, config: dubbingConfig, requestId },
  { long: true, cancelChannel: 'dubbing:cancel' },
);
mapped(
  'dubbing.resynthesize',
  'Resynthesize one cue with optional revised text and voice.',
  'dubbing:resynthesizeCue',
  {
    ...session,
    index: z.number().int().min(0),
    text: z.string().optional(),
    voiceId: str.optional(),
    config: dubbingConfig,
    requestId,
  },
  { long: true, cancelChannel: 'dubbing:cancel' },
);
mapped(
  'dubbing.edit',
  'Update cue texts with expected values using the existing session editing rules.',
  'dubbing:saveCueTexts',
  {
    ...session,
    edits: z.array(
      z
        .object({
          index: z.number().int().min(0),
          startMs: z.number().min(0),
          endMs: z.number().min(0),
          baseText: z.string(),
          text: z.string(),
        })
        .strict(),
    ),
  },
);
mapped(
  'dubbing.speaker-voice',
  'Set the voice for a speaker.',
  'dubbing:setSpeakerVoice',
  {
    ...session,
    speakerId: z.number().int(),
    voiceId: str,
    globalVoiceId: str,
    config: dubbingConfig.optional(),
  },
);
mapped(
  'dubbing.speaker-settings',
  'Set per-speaker synthesis settings.',
  'dubbing:setSpeakerSettings',
  {
    ...session,
    speakerId: z.number().int(),
    settings: z
      .object({
        speed: z.number().min(0.5).max(2),
        pitch: z.number().min(-12).max(12),
      })
      .strict(),
    config: dubbingConfig.optional(),
  },
);
mapped(
  'dubbing.cue-voice',
  'Set an individual cue voice.',
  'dubbing:setCueVoice',
  { ...session, index: z.number().int().min(0), voiceId: str },
);
mapped(
  'dubbing.media',
  'Set the video associated with a dubbing session.',
  'dubbing:setMedia',
  { ...session, videoPath: file },
);
mapped(
  'dubbing.borrow-silence',
  'Extend a cue into available following silence.',
  'dubbing:borrowSilence',
  { ...session, index: z.number().int().min(0), config: dubbingConfig },
);
read('voices.list', 'List cloned voices.', {}, 'voiceClone:list');
const range = {
  analysisId: str,
  startMs: z.number().min(0),
  endMs: z.number().positive(),
};
mapped(
  'voices.analyze',
  'Analyze reference audio before cloning.',
  'voiceClone:analyze',
  {
    sourcePath: file,
    engine: z.enum(['zipvoice', 'volcengine', 'elevenlabs']),
  },
  { long: true },
);
mapped(
  'voices.inspect',
  'Inspect a candidate reference range.',
  'voiceClone:inspectRange',
  { ...range, engine: z.enum(['zipvoice', 'volcengine', 'elevenlabs']) },
);
mapped(
  'voices.denoise',
  'Create denoised reference audio.',
  'voiceClone:denoisePreview',
  range,
  { long: true },
);
mapped(
  'voices.transcribe',
  'Transcribe a reference audio range.',
  'voiceClone:transcribeRange',
  { ...range, language: z.enum(['zh', 'en']) },
  { long: true },
);
mapped(
  'voices.create',
  'Create a cloned voice from a previously analyzed range.',
  'voiceClone:create',
  {
    ...range,
    engine: z.enum(['zipvoice', 'volcengine', 'elevenlabs']),
    language: z.enum(['zh', 'en']),
    name: str,
    refText: str,
    localDenoise: z.boolean().optional(),
    volc: config.optional(),
    eleven: config.optional(),
    requestId,
  },
  { long: true },
);
mapped('voices.rename', 'Rename a cloned voice.', 'voiceClone:rename', {
  ...id,
  name: str,
});
mapped(
  'voices.delete',
  'Remove a cloned voice. removeCloud explicitly opts into deleting the remote voice.',
  'voiceClone:remove',
  { ...id, removeCloud: z.boolean().default(false) },
);
read(
  'voices.cloud',
  'List voices from a cloud provider.',
  { providerId: str },
  'voiceClone:listCloudVoices',
);
mapped(
  'voices.link',
  'Link an existing cloud voice.',
  'voiceClone:linkCloudVoice',
  {
    engine: z.enum(['volcengine', 'elevenlabs']),
    providerId: str,
    speakerId: str,
    name: str.optional(),
    language: z.enum(['zh', 'en']),
  },
);
mapped(
  'voices.status',
  'Refresh cloud clone training status.',
  'voiceClone:volcRefreshStatus',
  id,
);
mapped(
  'voices.retrain',
  'Retrain a cloud voice.',
  'voiceClone:volcRetrain',
  { ...id, denoise: z.boolean().optional(), mss: z.boolean().optional() },
  { long: true },
);
mapped(
  'voices.sample',
  'Regenerate a cloned voice sample.',
  'voiceClone:regenerateSample',
  id,
  { long: true },
);
mapped(
  'voices.export',
  'Export a voice package to a new explicit path.',
  'voiceClone:export',
  { ...id, outputPath: file },
);
mapped(
  'voices.import',
  'Import a voice package from a local file.',
  'voiceClone:import',
  { sourcePath: file },
);
read(
  'downloads.engines',
  'Download engine installation status without a network update check.',
  { source: str.default('github'), fetchRemote: z.boolean().default(false) },
  'videoDownload:getStatuses',
);
mapped(
  'downloads.install',
  'Install or update yt-dlp or lux.',
  'videoDownload:install',
  {
    engine: z.enum(['yt-dlp', 'lux']),
    source: str.default('github'),
    requestId,
  },
  { long: true, cancelChannel: 'videoDownload:cancelInstall' },
);
mapped(
  'downloads.check',
  'Inspect video links and available formats.',
  'videoDownload:preflight',
  {
    urls: z.array(str).min(1),
    engine: z.enum(['auto', 'yt-dlp', 'lux']).default('auto'),
    requestId,
  },
  { long: true },
);
add(
  'downloads.start',
  'Download links; config uses StartDownloadPayload. Returns a job ID.',
  { config: downloadConfig, requestId },
  { long: true },
);
mapped('downloads.resume', 'Resume a download batch.', 'videoDownload:resume', {
  workItemId: str,
});
mapped(
  'downloads.retry',
  'Retry one download entry.',
  'videoDownload:retryEntry',
  { workItemId: str, entryId: str, updateFirst: z.boolean().default(false) },
);
read(
  'downloads.cookies',
  'List Cookie profile metadata; cookie contents are never returned.',
  {},
  'videoDownload:cookieProfiles:list',
);
mapped(
  'downloads.import-cookies',
  'Import a Netscape cookie file for a configured site.',
  'videoDownload:cookieProfiles:importFile',
  { ...id, sourcePath: file, customDef: config.optional() },
);
mapped(
  'downloads.delete-cookies',
  'Delete a cookie profile.',
  'videoDownload:cookieProfiles:delete',
  id,
);
read(
  'glossaries.list',
  'List glossary collections and entries.',
  {},
  'glossaries:list',
);
mapped('glossaries.create', 'Create a glossary.', 'glossaries:create', {
  name: str,
  description: z.string().optional(),
});
mapped('glossaries.update', 'Patch a glossary.', 'glossaries:update', {
  ...id,
  patch: object,
});
mapped('glossaries.delete', 'Delete a glossary.', 'glossaries:delete', id, {
  argument: 'id',
});
mapped(
  'glossaries.save-entry',
  'Create or update a glossary entry.',
  'glossaries:save-entry',
  { glossaryId: str, entry: object },
);
mapped(
  'glossaries.delete-entry',
  'Remove one glossary entry.',
  'glossaries:delete-entry',
  { glossaryId: str, entryId: str },
);
mapped('glossaries.import', 'Import CSV/TXT entries.', 'glossaries:import', {
  glossaryId: str,
  sourcePath: file,
});
mapped(
  'glossaries.export',
  'Export a glossary to a new file.',
  'glossaries:export',
  { glossaryId: str, format: z.enum(['csv', 'txt']), outputPath: file },
);
read('recipes.list', 'List saved workflow recipes.', {}, 'recipes:list');
mapped(
  'recipes.save',
  'Save a workflow recipe: name,goals,accepts,config.',
  'recipes:save',
  {
    recipe: z
      .object({
        id: str.optional(),
        name: str,
        goals: z.object({
          translate: z.boolean(),
          dub: z.boolean(),
          video: z.boolean(),
        }),
        accepts: z.enum(['media', 'subtitle']),
        config: pipelineConfig.optional(),
      })
      .strict(),
  },
  { argument: 'recipe' },
);
mapped('recipes.delete', 'Delete a saved recipe.', 'recipes:delete', id, {
  argument: 'id',
});

export const operationMap = new Map(operations.map((op) => [op.name, op]));
export function toolName(name: string) {
  return `smartsub_${name.replace(/[.-]/g, '_')}`;
}
