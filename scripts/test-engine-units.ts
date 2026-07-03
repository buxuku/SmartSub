/// <reference path="./test-globals.d.ts" />
/**
 * 引擎纯逻辑单元测试（无 Electron / 无模型依赖）。
 *
 * 覆盖 Phase 4 重构中抽取/搬迁的共享逻辑（回归风险最高的部分）：
 *  - transcribeShared: 时间格式化 / 语言归一 / 数值兜底 / VAD 设置
 *  - modelMap: ggml→CT2 显式映射（含 large-v3-turbo、量化后缀）
 *  - protocolSupport: 协议区间校验（安装/启动门禁）
 *
 * 运行：npm run test:engines
 * 注意：真实「whisper.cpp / faster-whisper 端到端转写」需模型+运行时，
 *       属手动冒烟（见 README 的 docs 说明 / 设计文档 §8），本脚本不覆盖。
 */
import {
  getNumericSetting,
  getWhisperLanguage,
  secondsToSrtTime,
  getVadSettings,
} from '../main/helpers/engines/transcribeShared';
import { toFasterWhisperModel } from '../main/helpers/engines/modelMap';
import {
  isProtocolSupported,
  isRemoteProtocolInstallable,
  SUPPORTED_PROTOCOL_MAX,
} from '../main/helpers/pythonRuntime/protocolSupport';
import {
  getSourceFallbackOrder,
  DEFAULT_SOURCE_ORDER,
} from '../main/helpers/downloadSourceOrder';
import { resolveProxyEnv } from '../main/helpers/network/proxyEnv';
import { resolveReleaseBaseUrl } from '../main/helpers/download/sources';
import { compareDateVersion } from '../main/helpers/download/versionCompare';
import { MirrorDownloader } from '../main/helpers/download/mirrorDownloader';
import {
  canHaveEmbeddedSubtitle,
  parseSubtitleStreams,
  srtHasCues,
} from '../main/helpers/embeddedSubtitleParser';
import { decideCloseIntent } from '../main/helpers/windowCloseDecision';
import fs from 'fs';
import os from 'os';
import nodePath from 'path';
import {
  getFunasrAsrModelIds,
  resolveFunasrAsrSelection,
  FUNASR_MODELS,
} from '../main/helpers/funasrModelCatalog';
import { QWEN_MODELS } from '../main/helpers/qwenModelCatalog';
import { FIRERED_MODELS } from '../main/helpers/fireRedModelCatalog';
import {
  validateModelLayout,
  resolveOverridePath,
  resolveBundledVadPath,
  SHERPA_VAD_SUBPATH,
} from '../main/helpers/modelImport';
import {
  buildVadConfig,
  buildRecognizerConfig,
  buildQwenRecognizerConfig,
  buildFireRedRecognizerConfig,
  segmentTiming,
  progressPercent,
} from '../main/helpers/sherpaOnnx/sherpaConfig';
import { buildQwenParams } from '../main/helpers/engines/qwenParams';
import {
  buildFireRedParams,
  clampFireRedMaxSpeech,
  FIRERED_HARD_MAX_SPEECH_S,
  FIRERED_DEFAULT_MAX_SPEECH_S,
} from '../main/helpers/engines/fireRedParams';
import {
  getSelectableModelsForEngine,
  getInstalledModelsForEngine,
  hasModelsForEngine,
} from '../renderer/lib/engineModels';
import {
  tokensToTriples,
  wordsToTriples,
  groupTokenCues,
  getSubtitleCueOptions,
  resplitSubtitleCues,
  composeWordCues,
  mergeShortCues,
  enforceMinDisplayDuration,
  clampTriplesToSpeechSegments,
  clampCuesToDominantSegments,
  dropCuesInDeepSilence,
  vadSegmentsToSpeech,
  type TokenTriple,
} from '../main/helpers/subtitleSegmentation';
import {
  resolveEffectiveSettings,
  inferSubtitleOutcome,
  inferDisplayOutcome,
  getSubtitleOutcome,
  isSherpaEngineId,
  outcomeSupportsContextKnobs,
} from '../main/helpers/engines/outcomePresets';
import {
  parseAsrModels,
  isAsrProviderConfigured,
  groupInstancesByType,
  ASR_PROVIDER_TYPES,
  getAsrPresetsForType,
  buildInstanceFromPreset,
  getAsrProviderType,
  resolveAudioLimits,
  ASR_OPENAI_COMPATIBLE,
  ASR_ELEVENLABS,
  ASR_VOLCENGINE,
  ASR_TENCENT,
  ASR_ALIYUN,
  ASR_XFYUN,
} from '../types/asrProvider';
import { computeChunkBoundaries } from '../main/helpers/cloudAudioChunking';
import {
  needsSpaceBefore,
  realignPunctuation,
  wordsToNativeTokens,
  wordCuesFromResult,
  segmentCuesFromSegments,
  singleCueFromText,
  offsetWords,
} from '../main/helpers/engines/cloudAsrShared';
import {
  normalizeBaseURL,
  normalizeLanguage,
  mapWords,
  isVerboseUnsupportedError,
} from '../main/service/asr/openaiCompatUtils';
import {
  normalizeElevenLabsBaseURL,
  buildSpeechToTextURL,
  mapElevenLabsWords,
  isRetriableStatus,
} from '../main/service/asr/elevenlabsUtils';
import {
  normalizeDeepgramBaseURL,
  buildListenURL,
  mapDeepgramWords,
  extractDeepgramResult,
} from '../main/service/asr/deepgramUtils';
import {
  normalizeVolcBaseURL,
  buildVolcHeaders,
  buildVolcRequestBody,
  buildSilentWavBase64,
  classifyVolcStatus,
  extractVolcResult,
} from '../main/service/asr/volcengineUtils';
import {
  TENCENT_ASR_HOST,
  TENCENT_FLASH_PATH,
  buildTencentParams,
  buildTencentQuery,
  resolveTencentEngineType,
  signTencentRequest,
  voiceFormatFromPath,
  extractTencentResult,
  classifyTencentCode,
} from '../main/service/asr/tencentUtils';
import {
  ALIYUN_NLS_GATEWAY_HOST,
  ALIYUN_FLASH_PATH,
  ALIYUN_META_HOST,
  percentEncodeRfc3986,
  buildCreateTokenQuery,
  signCreateToken,
  isTokenExpired,
  buildFlashQuery,
  extractAliyunResult,
  classifyAliyunStatus,
} from '../main/service/asr/aliyunUtils';
import {
  XFYUN_API_HOST,
  XFYUN_UPLOAD_PATH,
  XFYUN_GET_RESULT_PATH,
  normalizeXfyunTier,
  resolveXfyunLanguageSupport,
  buildXfyunDateTime,
  buildXfyunRandom,
  javaUrlEncode,
  buildXfyunQuery,
  signXfyunRequest,
  xfyunFileNameFromPath,
  classifyXfyunCode,
  isXfyunOrderGone,
  mapXfyunFailType,
  extractXfyunResult,
} from '../main/service/asr/xfyunUtils';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

// --- secondsToSrtTime ---
eq(secondsToSrtTime(0), '00:00:00.000', 'srt: zero');
eq(secondsToSrtTime(1.5), '00:00:01.500', 'srt: 1.5s');
eq(secondsToSrtTime(3661.234), '01:01:01.234', 'srt: 1h1m1.234s');
eq(secondsToSrtTime(-5), '00:00:00.000', 'srt: negative clamps to 0');

// --- getWhisperLanguage ---
eq(getWhisperLanguage(undefined), 'auto', 'lang: undefined -> auto');
eq(getWhisperLanguage('auto'), 'auto', 'lang: auto');
eq(getWhisperLanguage('zh'), 'zh', 'lang: zh');
eq(getWhisperLanguage('zh-CN'), 'zh', 'lang: zh-CN -> zh');
eq(getWhisperLanguage('zh-TW'), 'zh', 'lang: zh-TW -> zh');
eq(getWhisperLanguage('EN'), 'en', 'lang: EN -> en');
eq(getWhisperLanguage('yue'), 'yue', 'lang: yue stays yue');

// --- getNumericSetting ---
eq(getNumericSetting(5, 1), 5, 'num: valid number');
eq(getNumericSetting(0, 1), 0, 'num: zero is valid');
eq(getNumericSetting(undefined, 1), 1, 'num: undefined -> default');
eq(getNumericSetting(NaN, 1), 1, 'num: NaN -> default');
eq(getNumericSetting('x', 1), 1, 'num: string -> default');

// --- getVadSettings ---
eq(
  getVadSettings({}),
  {
    useVAD: true,
    vadThreshold: 0.5,
    vadMinSpeechDuration: 250,
    vadMinSilenceDuration: 100,
    vadMaxSpeechDuration: 0,
    vadSpeechPad: 200,
    vadSamplesOverlap: 0.1,
  },
  'vad: defaults',
);
eq(getVadSettings({ useVAD: false }).useVAD, false, 'vad: useVAD false');
eq(
  getVadSettings({ vadThreshold: 0.8 }).vadThreshold,
  0.8,
  'vad: custom threshold passthrough',
);

// --- toFasterWhisperModel ---
eq(toFasterWhisperModel('large-v3-turbo'), 'large-v3-turbo', 'model: turbo');
eq(
  toFasterWhisperModel('large-v3-turbo-q5_0'),
  'large-v3-turbo',
  'model: turbo + quant suffix stripped',
);
eq(toFasterWhisperModel('base'), 'base', 'model: base');
eq(toFasterWhisperModel(undefined), 'base', 'model: undefined -> base');
eq(toFasterWhisperModel('LARGE-V3'), 'large-v3', 'model: uppercase normalized');
eq(toFasterWhisperModel('tiny.en'), 'tiny.en', 'model: tiny.en');
// 未命中映射回退原值（去后缀），fallback 会 console.warn，这里临时静音保持输出整洁
{
  const orig = console.warn;
  console.warn = () => {};
  eq(
    toFasterWhisperModel('unknown-model'),
    'unknown-model',
    'model: unknown falls back to itself',
  );
  console.warn = orig;
}

// --- protocolSupport ---
eq(SUPPORTED_PROTOCOL_MAX, 1, 'proto: SUPPORTED_PROTOCOL_MAX is 1');
eq(isProtocolSupported(1), true, 'proto: 1 supported');
eq(isProtocolSupported(0), false, 'proto: 0 unsupported');
eq(isProtocolSupported(2), false, 'proto: 2 above max unsupported');
eq(isProtocolSupported(undefined), false, 'proto: undefined unsupported');
eq(
  isRemoteProtocolInstallable(null),
  true,
  'proto: null remote installable (old release)',
);
eq(
  isRemoteProtocolInstallable({
    engineVersion: '0.1.0',
    protocolVersion: 1,
    builtAt: '',
    engines: ['faster_whisper'],
    runtime: { artifacts: {} },
  }),
  true,
  'proto: remote v1 installable',
);
eq(
  isRemoteProtocolInstallable({
    engineVersion: '9.9.9',
    protocolVersion: 99,
    builtAt: '',
    engines: ['faster_whisper'],
    runtime: { artifacts: {} },
  }),
  false,
  'proto: remote v99 blocked',
);

eq(
  getSourceFallbackOrder('gitcode').join(','),
  'gitcode,ghproxy,github',
  'order: gitcode selected keeps canonical order',
);
eq(
  getSourceFallbackOrder('github').join(','),
  'github,gitcode,ghproxy',
  'order: github first then canonical remainder',
);
eq(
  getSourceFallbackOrder('ghproxy').join(','),
  'ghproxy,gitcode,github',
  'order: ghproxy first then canonical remainder',
);
eq(
  getSourceFallbackOrder('github').length,
  DEFAULT_SOURCE_ORDER.length,
  'order: no duplicates, full coverage',
);

// --- resolveProxyEnv ---
eq(
  resolveProxyEnv({ proxyMode: 'none' }),
  { httpProxy: '', noProxy: '' },
  'proxy: none -> empty',
);
eq(
  resolveProxyEnv({}),
  { httpProxy: '', noProxy: '' },
  'proxy: undefined mode -> empty',
);
eq(
  resolveProxyEnv({
    proxyMode: 'custom',
    proxyUrl: '  http://127.0.0.1:7890  ',
  }),
  { httpProxy: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1' },
  'proxy: custom trims url + default no_proxy',
);
eq(
  resolveProxyEnv({ proxyMode: 'custom', proxyUrl: '' }),
  { httpProxy: '', noProxy: '' },
  'proxy: custom without url -> empty (no proxy)',
);
eq(
  resolveProxyEnv({
    proxyMode: 'custom',
    proxyUrl: 'http://h:1',
    proxyNoProxy: 'localhost,example.com',
  }),
  { httpProxy: 'http://h:1', noProxy: 'localhost,example.com' },
  'proxy: custom passes through no_proxy',
);

// --- resolveReleaseBaseUrl (addon slugs: gitcode repo differs!) ---
const ADDON = { github: 'buxuku/whisper.cpp', gitcode: 'buxuku1/whisper.node' };
eq(
  resolveReleaseBaseUrl('github', ADDON, 'latest'),
  'https://github.com/buxuku/whisper.cpp/releases/download/latest',
  'url: addon github',
);
eq(
  resolveReleaseBaseUrl('ghproxy', ADDON, 'latest'),
  'https://gh-proxy.com/https://github.com/buxuku/whisper.cpp/releases/download/latest',
  'url: addon ghproxy',
);
eq(
  resolveReleaseBaseUrl('gitcode', ADDON, 'latest'),
  'https://gitcode.com/buxuku1/whisper.node/releases/download/latest',
  'url: addon gitcode (different repo slug)',
);
// --- resolveReleaseBaseUrl (py slugs) ---
const PY = {
  github: 'buxuku/smartsub-py-engine',
  gitcode: 'buxuku1/smartsub-py-engine',
};
eq(
  resolveReleaseBaseUrl('github', PY, 'latest'),
  'https://github.com/buxuku/smartsub-py-engine/releases/download/latest',
  'url: py github',
);
eq(
  resolveReleaseBaseUrl('ghproxy', PY, 'latest'),
  'https://gh-proxy.com/https://github.com/buxuku/smartsub-py-engine/releases/download/latest',
  'url: py ghproxy',
);
eq(
  resolveReleaseBaseUrl('gitcode', PY, 'latest'),
  'https://gitcode.com/buxuku1/smartsub-py-engine/releases/download/latest',
  'url: py gitcode',
);

// --- compareDateVersion (normalizes '-' and '.') ---
eq(compareDateVersion('2026.06.10', '2026-06-10'), 0, 'ver: dot vs dash equal');
eq(compareDateVersion('2026.06.11', '2026.06.10'), 1, 'ver: newer day');
eq(compareDateVersion('2026.06.10', '2026.06.11'), -1, 'ver: older day');
eq(compareDateVersion('2027.01.01', '2026.12.31'), 1, 'ver: cross year');
eq(compareDateVersion('2026.06.10', '2026.06.10'), 0, 'ver: equal');

// --- MirrorDownloader.updateProgress percent math ---
{
  const md = new MirrorDownloader(() => {});
  md.resetForDownload();
  md.updateProgress({ total: 200, downloaded: 50 });
  eq(md.getProgress().progress, 25, 'mirror: 50/200 -> 25%');
  md.updateProgress({ downloaded: 200 });
  eq(md.getProgress().progress, 100, 'mirror: 200/200 -> 100%');
  eq(md.getProgress().status, 'idle', 'mirror: status unchanged by bytes');
}

// --- embedded subtitle: parseSubtitleStreams ---
const MKV_MIXED = [
  "Input #0, matroska,webm, from 'movie.mkv':",
  '  Duration: 01:23:45.00, start: 0.000000, bitrate: 4500 kb/s',
  '    Stream #0:0(eng): Video: h264 (High), yuv420p, 1920x1080, 23.98 fps',
  '    Stream #0:1(eng): Audio: aac, 48000 Hz, stereo, fltp',
  '    Stream #0:2(eng): Subtitle: hdmv_pgs_subtitle (default)',
  '    Stream #0:3(chi): Subtitle: subrip',
  '    Stream #0:4(jpn): Subtitle: ass (forced)',
].join('\n');
eq(
  parseSubtitleStreams(MKV_MIXED),
  [
    {
      subIndex: 0,
      codec: 'hdmv_pgs_subtitle',
      language: 'eng',
      isText: false,
      isDefault: true,
      isForced: false,
    },
    {
      subIndex: 1,
      codec: 'subrip',
      language: 'chi',
      isText: true,
      isDefault: false,
      isForced: false,
    },
    {
      subIndex: 2,
      codec: 'ass',
      language: 'jpn',
      isText: true,
      isDefault: false,
      isForced: true,
    },
  ],
  'embed: mkv mixed image+text tracks',
);

const MP4_MOVTEXT = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '    Stream #0:0(und): Video: h264, yuv420p, 1280x720',
  '    Stream #0:1(und): Audio: aac, 44100 Hz, stereo',
  '    Stream #0:2(und): Subtitle: mov_text (default)',
].join('\n');
eq(
  parseSubtitleStreams(MP4_MOVTEXT),
  [
    {
      subIndex: 0,
      codec: 'mov_text',
      isText: true,
      isDefault: true,
      isForced: false,
    },
  ],
  'embed: mp4 mov_text, und language omitted',
);

eq(
  parseSubtitleStreams(
    '    Stream #0:2[0x21](eng): Subtitle: subrip (default)',
  ),
  [
    {
      subIndex: 0,
      codec: 'subrip',
      language: 'eng',
      isText: true,
      isDefault: true,
      isForced: false,
    },
  ],
  'embed: stream with hex id',
);

const AUDIO_ONLY = [
  "Input #0, mp3, from 'a.mp3':",
  '    Stream #0:0: Audio: mp3, 16000 Hz, mono, fltp, 64 kb/s',
].join('\n');
eq(
  parseSubtitleStreams(AUDIO_ONLY),
  [],
  'embed: audio only -> no subtitle streams',
);

// --- embedded subtitle: canHaveEmbeddedSubtitle ---
eq(canHaveEmbeddedSubtitle('.mkv'), true, 'embed: .mkv allowed');
eq(canHaveEmbeddedSubtitle('mkv'), true, 'embed: mkv allowed (no dot)');
eq(canHaveEmbeddedSubtitle('.MP4'), true, 'embed: .MP4 case-insensitive');
eq(canHaveEmbeddedSubtitle('.mp3'), false, 'embed: .mp3 audio skipped');
eq(canHaveEmbeddedSubtitle('.avi'), false, 'embed: .avi skipped');
eq(canHaveEmbeddedSubtitle(''), false, 'embed: empty ext skipped');

// --- embedded subtitle: srtHasCues ---
eq(
  srtHasCues('1\n00:00:01,000 --> 00:00:03,000\nHello\n'),
  true,
  'embed: srt with cue',
);
eq(srtHasCues(''), false, 'embed: empty srt no cue');
eq(srtHasCues('   \n  \n'), false, 'embed: whitespace srt no cue');

// --- decideCloseIntent (关闭窗口行为矩阵) ---
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'smart', busy: true }),
  'background',
  'close: mac smart busy -> background',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'smart', busy: false }),
  'quit',
  'close: mac smart idle -> quit',
);
eq(
  decideCloseIntent({
    platform: 'darwin',
    closeAction: 'background',
    busy: false,
  }),
  'background',
  'close: mac background idle -> background',
);
eq(
  decideCloseIntent({
    platform: 'darwin',
    closeAction: 'background',
    busy: true,
  }),
  'background',
  'close: mac background busy -> background',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'quit', busy: false }),
  'quit',
  'close: mac quit idle -> quit',
);
eq(
  decideCloseIntent({ platform: 'darwin', closeAction: 'quit', busy: true }),
  'confirm-quit',
  'close: mac quit busy -> confirm-quit',
);
eq(
  decideCloseIntent({ platform: 'win32', closeAction: 'smart', busy: true }),
  'confirm-quit',
  'close: win busy -> confirm-quit',
);
eq(
  decideCloseIntent({ platform: 'win32', closeAction: 'smart', busy: false }),
  'quit',
  'close: win idle -> quit',
);
eq(
  decideCloseIntent({
    platform: 'linux',
    closeAction: 'background',
    busy: true,
  }),
  'confirm-quit',
  'close: linux ignores background, busy -> confirm-quit',
);
eq(
  decideCloseIntent({
    platform: 'linux',
    closeAction: 'background',
    busy: false,
  }),
  'quit',
  'close: linux ignores background, idle -> quit',
);

// --- funasr catalog: ASR model ids (VAD excluded) ---
eq(
  getFunasrAsrModelIds().sort().join(','),
  'paraformer-zh,sensevoice-small',
  'funasr: asr ids exclude vad',
);

// --- funasr catalog: resolveFunasrAsrSelection ---
eq(
  resolveFunasrAsrSelection('paraformer-zh', [
    'sensevoice-small',
    'paraformer-zh',
  ]),
  { id: 'paraformer-zh', modelType: 'paraformer' },
  'funasr: requested paraformer resolves',
);
eq(
  resolveFunasrAsrSelection('sensevoice-small', ['sensevoice-small']),
  { id: 'sensevoice-small', modelType: 'sense_voice' },
  'funasr: requested sensevoice resolves',
);
eq(
  resolveFunasrAsrSelection('paraformer-zh', ['sensevoice-small']),
  { id: 'sensevoice-small', modelType: 'sense_voice' },
  'funasr: not-installed request falls back to first installed asr',
);
eq(
  resolveFunasrAsrSelection(undefined, ['paraformer-zh']),
  { id: 'paraformer-zh', modelType: 'paraformer' },
  'funasr: no request uses first installed asr',
);
eq(
  resolveFunasrAsrSelection('sensevoice-small', []),
  null,
  'funasr: no installed asr -> null',
);

// --- engineModels: funasr awareness ---
const funasrReady = {
  transcriptionEngine: 'funasr' as const,
  funasrVadInstalled: true,
  funasrAsrModelsInstalled: ['sensevoice-small', 'paraformer-zh'],
};
eq(
  getSelectableModelsForEngine(funasrReady),
  ['sensevoice-small', 'paraformer-zh'],
  'engineModels: funasr selectable = installed asr',
);
eq(
  getInstalledModelsForEngine(funasrReady),
  ['sensevoice-small', 'paraformer-zh'],
  'engineModels: funasr installed = installed asr',
);
eq(
  hasModelsForEngine(funasrReady),
  true,
  'engineModels: funasr ready w/ vad+asr',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'funasr',
    funasrVadInstalled: false,
    funasrAsrModelsInstalled: ['sensevoice-small'],
  }),
  false,
  'engineModels: funasr not ready without vad',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'funasr',
    funasrVadInstalled: true,
    funasrAsrModelsInstalled: [],
  }),
  false,
  'engineModels: funasr not ready without asr',
);
eq(
  getSelectableModelsForEngine({ transcriptionEngine: 'funasr' }),
  [],
  'engineModels: funasr selectable empty when undefined',
);

// --- engineModels: qwen awareness ---
const qwenReady = {
  transcriptionEngine: 'qwen' as const,
  qwenEngineInstalled: true,
  qwenVadInstalled: true,
  qwenModelsInstalled: ['qwen3-asr-0.6b'],
};
eq(
  getSelectableModelsForEngine(qwenReady),
  ['qwen3-asr-0.6b'],
  'engineModels: qwen selectable = installed qwen models',
);
eq(
  getInstalledModelsForEngine(qwenReady),
  ['qwen3-asr-0.6b'],
  'engineModels: qwen installed = installed qwen models',
);
eq(
  hasModelsForEngine(qwenReady),
  true,
  'engineModels: qwen ready w/ vad+model',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'qwen',
    qwenVadInstalled: false,
    qwenModelsInstalled: ['qwen3-asr-0.6b'],
  }),
  false,
  'engineModels: qwen not ready without vad',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'qwen',
    qwenVadInstalled: true,
    qwenModelsInstalled: [],
  }),
  false,
  'engineModels: qwen not ready without model',
);

// --- sherpaConfig: VAD/recognizer 映射 + 段时间/进度 ---
const SHERPA_P = {
  language: 'auto',
  use_itn: true,
  provider: 'cpu',
  num_threads: 2,
  vad_threshold: 0.5,
  vad_min_silence_duration_ms: 100,
  vad_min_speech_duration_ms: 250,
  vad_max_speech_duration_s: 0,
};
eq(
  buildVadConfig('/m/silero_vad.onnx', SHERPA_P).sileroVad,
  {
    model: '/m/silero_vad.onnx',
    threshold: 0.5,
    minSpeechDuration: 0.25,
    minSilenceDuration: 0.1,
    windowSize: 512,
    maxSpeechDuration: 100000,
  },
  'sherpa: vad config maps ms->s and 0->unlimited',
);
eq(
  buildRecognizerConfig(
    'sense_voice',
    '/m/model.int8.onnx',
    '/m/tokens.txt',
    SHERPA_P,
  ).modelConfig.senseVoice,
  { model: '/m/model.int8.onnx', language: '', useInverseTextNormalization: 1 },
  'sherpa: sensevoice config (auto->"", itn on)',
);
eq(
  buildRecognizerConfig(
    'paraformer',
    '/m/model.int8.onnx',
    '/m/tokens.txt',
    SHERPA_P,
  ).modelConfig.paraformer,
  { model: '/m/model.int8.onnx' },
  'sherpa: paraformer config',
);
eq(
  buildRecognizerConfig('paraformer', '/m/a.onnx', '/m/t.txt', SHERPA_P)
    .modelConfig.senseVoice,
  undefined,
  'sherpa: paraformer has no senseVoice block',
);
eq(
  segmentTiming(16000, 8000),
  { start: 1, end: 1.5 },
  'sherpa: segment timing sec',
);
eq(progressPercent(50, 200), 25, 'sherpa: progress 25%');
eq(progressPercent(5, 0), 100, 'sherpa: progress total 0 -> 100');

// --- sherpa: qwen3_asr recognizer config 映射 ---
const QWEN_RP = {
  num_threads: 2,
  provider: 'cpu',
  max_total_len: 512,
  max_new_tokens: 128,
  temperature: 1e-6,
  top_p: 0.8,
  seed: 42,
  vad_threshold: 0.5,
  vad_min_silence_duration_ms: 100,
  vad_min_speech_duration_ms: 250,
  vad_max_speech_duration_s: 0,
};
eq(
  buildQwenRecognizerConfig(
    {
      convFrontend: '/m/conv.onnx',
      encoder: '/m/enc.onnx',
      decoder: '/m/dec.onnx',
      tokenizer: '/m/tokenizer',
    },
    QWEN_RP,
  ).modelConfig.qwen3Asr,
  {
    convFrontend: '/m/conv.onnx',
    encoder: '/m/enc.onnx',
    decoder: '/m/dec.onnx',
    tokenizer: '/m/tokenizer',
    maxTotalLen: 512,
    maxNewTokens: 128,
    temperature: 1e-6,
    topP: 0.8,
    seed: 42,
  },
  'sherpa: qwen3_asr maps four files + all decode params (memset-safe)',
);
eq(
  buildQwenRecognizerConfig(
    { convFrontend: '', encoder: '', decoder: '', tokenizer: '' },
    QWEN_RP,
  ).modelConfig.tokens,
  '',
  'sherpa: qwen3_asr uses empty tokens (tokenizer dir instead)',
);
// VAD 配置在 funasr / qwen 间共享（结构兼容）
eq(
  buildVadConfig('/m/silero_vad.onnx', QWEN_RP).sileroVad.windowSize,
  512,
  'sherpa: qwen reuses shared VAD config builder',
);

// --- qwenParams: 默认值对齐 sherpa 上游 ---
eq(
  buildQwenParams({}),
  {
    provider: 'cpu',
    num_threads: 2,
    max_total_len: 512,
    max_new_tokens: 128,
    temperature: 1e-6,
    top_p: 0.8,
    seed: 42,
    vad_threshold: 0.5,
    vad_min_silence_duration_ms: 100,
    vad_min_speech_duration_ms: 250,
    vad_max_speech_duration_s: 0,
  },
  'qwen: default params match sherpa upstream defaults',
);
eq(
  buildQwenParams({ qwenProvider: 'cuda', qwenNumThreads: 4 }).provider,
  'cuda',
  'qwen: cuda provider passthrough',
);
eq(
  buildQwenParams({ qwenProvider: 'metal' as never }).provider,
  'cpu',
  'qwen: unknown provider falls back to cpu',
);
eq(
  buildQwenParams({ qwenMaxNewTokens: 256, qwenTemperature: 0.2 })
    .max_new_tokens,
  256,
  'qwen: custom max_new_tokens passthrough',
);

// --- engineModels: fireRedAsr awareness ---
const fireRedReady = {
  transcriptionEngine: 'fireRedAsr' as const,
  fireRedEngineInstalled: true,
  fireRedVadInstalled: true,
  fireRedModelsInstalled: ['fire-red-asr-large-zh-en'],
};
eq(
  getSelectableModelsForEngine(fireRedReady),
  ['fire-red-asr-large-zh-en'],
  'engineModels: fireRed selectable = installed fireRed models',
);
eq(
  getInstalledModelsForEngine(fireRedReady),
  ['fire-red-asr-large-zh-en'],
  'engineModels: fireRed installed = installed fireRed models',
);
eq(
  hasModelsForEngine(fireRedReady),
  true,
  'engineModels: fireRed ready w/ vad+model',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'fireRedAsr',
    fireRedVadInstalled: false,
    fireRedModelsInstalled: ['fire-red-asr-large-zh-en'],
  }),
  false,
  'engineModels: fireRed not ready without vad',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'fireRedAsr',
    fireRedVadInstalled: true,
    fireRedModelsInstalled: [],
  }),
  false,
  'engineModels: fireRed not ready without model',
);

// --- sherpa: fire_red_asr recognizer config 映射 ---
const FIRERED_RP = { num_threads: 2, provider: 'cpu' };
eq(
  buildFireRedRecognizerConfig(
    { encoder: '/m/enc.int8.onnx', decoder: '/m/dec.int8.onnx' },
    '/m/tokens.txt',
    FIRERED_RP,
  ).modelConfig.fireRedAsr,
  { encoder: '/m/enc.int8.onnx', decoder: '/m/dec.int8.onnx' },
  'sherpa: fire_red_asr maps encoder+decoder',
);
eq(
  buildFireRedRecognizerConfig(
    { encoder: '/m/enc.int8.onnx', decoder: '/m/dec.int8.onnx' },
    '/m/tokens.txt',
    FIRERED_RP,
  ).modelConfig.tokens,
  '/m/tokens.txt',
  'sherpa: fire_red_asr uses top-level tokens (unlike qwen tokenizer dir)',
);
eq(
  buildFireRedRecognizerConfig(
    { encoder: '/m/e.onnx', decoder: '/m/d.onnx' },
    '/m/t.txt',
    FIRERED_RP,
  ).modelConfig.qwen3Asr,
  undefined,
  'sherpa: fire_red_asr has no qwen3Asr block',
);

// --- fireRedParams: 默认值 + 段长安全闸（design D8） ---
eq(
  buildFireRedParams({}),
  {
    provider: 'cpu',
    num_threads: 2,
    vad_threshold: 0.5,
    vad_min_silence_duration_ms: 100,
    vad_min_speech_duration_ms: 250,
    vad_max_speech_duration_s: FIRERED_DEFAULT_MAX_SPEECH_S,
  },
  'fireRed: default params (max speech clamped to 30s, not 0/unlimited)',
);
eq(
  buildFireRedParams({ fireRedProvider: 'cuda', fireRedNumThreads: 4 })
    .provider,
  'cuda',
  'fireRed: cuda provider passthrough',
);
eq(
  buildFireRedParams({ fireRedProvider: 'metal' as never }).provider,
  'cpu',
  'fireRed: unknown provider falls back to cpu',
);
// 段长安全闸：0/未设/超限 → 60s 硬上限或 30s 默认；合法值原样。
eq(
  clampFireRedMaxSpeech(0),
  FIRERED_HARD_MAX_SPEECH_S,
  'fireRed: 0 (unlimited) clamps to 60s hard cap',
);
eq(
  clampFireRedMaxSpeech(120),
  FIRERED_HARD_MAX_SPEECH_S,
  'fireRed: >60 clamps to 60s hard cap',
);
eq(clampFireRedMaxSpeech(45), 45, 'fireRed: in-range value passes through');
eq(
  clampFireRedMaxSpeech(undefined),
  FIRERED_DEFAULT_MAX_SPEECH_S,
  'fireRed: undefined -> 30s default',
);
eq(
  buildFireRedParams({ vadMaxSpeechDuration: 0 }).vad_max_speech_duration_s,
  FIRERED_HARD_MAX_SPEECH_S,
  'fireRed: buildFireRedParams overrides 0=unlimited convention (clamps to 60)',
);

// --- modelImport: validateModelLayout（含嵌套相对路径） ---
{
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'modelimport-'));
  fs.writeFileSync(nodePath.join(tmp, 'encoder.int8.onnx'), 'x');
  fs.writeFileSync(nodePath.join(tmp, 'decoder.int8.onnx'), 'x');
  fs.writeFileSync(nodePath.join(tmp, 'tokens.txt'), 'x');
  eq(
    validateModelLayout(tmp, [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokens.txt',
    ]).ok,
    true,
    'import: complete fireRed layout -> ok',
  );
  eq(
    validateModelLayout(tmp, ['tokenizer/vocab.json']).missing,
    ['tokenizer/vocab.json'],
    'import: missing nested file -> reported in missing',
  );
  fs.mkdirSync(nodePath.join(tmp, 'tokenizer'), { recursive: true });
  fs.writeFileSync(nodePath.join(tmp, 'tokenizer', 'vocab.json'), 'x');
  eq(
    validateModelLayout(tmp, ['tokenizer/vocab.json']).ok,
    true,
    'import: present nested file -> ok',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- modelImport: resolveOverridePath（覆盖优先/空值回退） ---
eq(
  resolveOverridePath('/custom/models', '/default/models'),
  '/custom/models',
  'path: override wins',
);
eq(
  resolveOverridePath(undefined, '/default/models'),
  '/default/models',
  'path: undefined -> fallback',
);
eq(
  resolveOverridePath('', '/default/models'),
  '/default/models',
  'path: empty -> fallback',
);
eq(
  resolveOverridePath('   ', '/default/models'),
  '/default/models',
  'path: whitespace -> fallback',
);

// --- modelImport: 内置共享 VAD 路径（随包内置，与引擎模型根解耦） ---
eq(
  SHERPA_VAD_SUBPATH,
  nodePath.join('sherpa', 'vad', 'silero_vad.onnx'),
  'vad: bundled subpath is sherpa/vad/silero_vad.onnx',
);
eq(
  resolveBundledVadPath('/opt/app/extraResources'),
  nodePath.join('/opt/app/extraResources', 'sherpa', 'vad', 'silero_vad.onnx'),
  'vad: resolveBundledVadPath joins extraResources root (engine-root independent)',
);

// --- catalog requiredFiles（导入消歧/嵌套校验集来源） ---
eq(
  FUNASR_MODELS['sensevoice-small'].requiredFiles,
  FUNASR_MODELS['paraformer-zh'].requiredFiles,
  'import: funasr two ASR models share requiredFiles (must disambiguate by id)',
);
eq(
  QWEN_MODELS['qwen3-asr-0.6b'].requiredFiles.includes('tokenizer/vocab.json'),
  true,
  'import: qwen requiredFiles include nested tokenizer file',
);
eq(
  FIRERED_MODELS['fire-red-asr-large-zh-en'].requiredFiles,
  ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
  'import: fireRed requiredFiles',
);

// --- subtitleSegmentation: tokensToTriples（原生逐 token 毫秒 → 字幕三元组） ---
const T = (a: string, b: string, c: string): TokenTriple => [a, b, c];
{
  // 毫秒 t0/t1 → HH:MM:SS,mmm；段间停顿（gap）由原生 segment-aware 映射保留，原样转成 TokenTriple
  eq(
    tokensToTriples([
      { text: '你好', t0: 0, t1: 2000 },
      { text: '世界', t0: 12000, t1: 13000 },
    ]),
    [
      ['00:00:00,000', '00:00:02,000', '你好'],
      ['00:00:12,000', '00:00:13,000', '世界'],
    ],
    'tokensToTriples: ms token times -> SRT triples (native gap preserved)',
  );
  // 时间非法（NaN/缺失）→ 该端输出空串（groupTokenCues 会并入文本、不作为切分依据、不丢字）
  eq(
    tokensToTriples([{ text: 'x', t0: NaN as unknown as number, t1: 500 }]),
    [['', '00:00:00,500', 'x']],
    'tokensToTriples: non-finite start emits empty string (no split, no drop)',
  );
  // 空 / 非数组输入 → 空数组（优雅降级）
  eq(tokensToTriples([]), [], 'tokensToTriples: empty input -> empty output');
}

// --- subtitleSegmentation: vadSegmentsToSpeech + clampTriplesToSpeechSegments ---
{
  // 毫秒 VAD 段 → 秒、排序、丢弃非法段
  eq(
    vadSegmentsToSpeech([
      { t0: 25110, t1: 27140 },
      { t0: 19500, t1: 21510 },
      { t0: 5000, t1: 5000 }, // 非法（end<=start）丢弃
    ]),
    [
      { start: 19.5, end: 21.51 },
      { start: 25.11, end: 27.14 },
    ],
    'vadSegmentsToSpeech: ms->s, sorted, drops invalid',
  );

  const segs = [
    { start: 19.5, end: 21.51 },
    { start: 25.11, end: 27.14 },
  ];
  // token 落在语音段内 → 原样保留；落在段间静音 → 就近吸附到边界（不再压在静音上）
  eq(
    clampTriplesToSpeechSegments(
      [
        T('00:00:20,000', '00:00:21,000', '攝氏'), // 段内
        T('00:00:22,000', '00:00:23,000', '度'), // 静音(21.51-25.11)，中点22.5→近段尾21.51
        T('00:00:26,000', '00:00:26,500', '請'), // 段内
      ],
      segs,
    ),
    [
      ['00:00:20,000', '00:00:21,000', '攝氏'],
      ['00:00:21,510', '00:00:21,510', '度'],
      ['00:00:26,000', '00:00:26,500', '請'],
    ],
    'clampTriplesToSpeechSegments: silence token snaps to nearest boundary',
  );
  // 夹紧后 group：静音前后被自然间隔切成两条，字幕不糊穿静音
  eq(
    groupTokenCues(
      clampTriplesToSpeechSegments(
        [
          T('00:00:20,800', '00:00:21,000', '溫'),
          T('00:00:23,000', '00:00:24,000', '請'), // 静音中点≈23.5→近段首25.11? 中点距离: 到21.51=1.99,到25.11=1.61→近段首
          T('00:00:26,000', '00:00:26,500', '記'),
        ],
        segs,
      ),
    ).length >= 2,
    true,
    'clamp+group: silence yields a cue split (no spill across silence)',
  );
  // 无段信息（VAD 关 / 旧加速包）→ 恒等变换
  eq(
    clampTriplesToSpeechSegments([T('00:00:01,000', '00:00:02,000', 'x')], []),
    [['00:00:01,000', '00:00:02,000', 'x']],
    'clampTriplesToSpeechSegments: no segments -> identity',
  );
}

// --- subtitleSegmentation: clampCuesToDominantSegments + dropCuesInDeepSilence（VAD 关路径）---
{
  const energy = [
    { start: 14.0, end: 17.0 }, // 句子真正所在段
    { start: 25.0, end: 30.0 },
  ];
  // cue 跨静音糊穿（11→15.5，含 10.9-13.9 静音）：主导段 14-17 覆盖率高 → 整条后移到 14，不碎词
  eq(
    clampCuesToDominantSegments(
      [T('00:00:11,000', '00:00:15,500', '今天是2026年6月25日')],
      energy,
    ),
    [['00:00:14,000', '00:00:15,500', '今天是2026年6月25日']],
    'clampCuesToDominantSegments: cue moves to dominant segment (no word split)',
  );
  // 弱重叠（只擦到段尾 0.2s）→ 不夹（避免夹成碎片），原样保留
  eq(
    clampCuesToDominantSegments(
      [T('00:00:21,000', '00:00:23,000', '请记录以下信息')],
      [
        { start: 19.5, end: 21.2 },
        { start: 25.0, end: 30.0 },
      ],
    ),
    [['00:00:21,000', '00:00:23,000', '请记录以下信息']],
    'clampCuesToDominantSegments: weak overlap left untouched',
  );
  // segments 为空 → 恒等
  eq(
    clampCuesToDominantSegments([T('00:00:01,000', '00:00:02,000', 'x')], []),
    [['00:00:01,000', '00:00:02,000', 'x']],
    'clampCuesToDominantSegments: no segments -> identity',
  );
  // 深静音悬空 cue（离最近段 >1.5s 且零重叠）→ 丢弃；贴边界真实尾字（<1.5s）→ 保留
  eq(
    dropCuesInDeepSilence(
      [
        T('00:00:14,000', '00:00:15,000', '真实'),
        T('00:00:22,000', '00:00:23,000', '幻觉'), // 距段(17/25)>1.5s 且零重叠 → 丢
        T('00:00:17,300', '00:00:17,600', '尾字'), // 距段尾17.0=0.3s → 保留
      ],
      [
        { start: 13.0, end: 17.0 },
        { start: 25.0, end: 30.0 },
      ],
    ),
    [
      ['00:00:14,000', '00:00:15,000', '真实'],
      ['00:00:17,300', '00:00:17,600', '尾字'],
    ],
    'dropCuesInDeepSilence: drops deep-silence hallucination, keeps boundary word',
  );
  // segments 为空 → 原样（优雅降级，绝不无依据删字幕）
  eq(
    dropCuesInDeepSilence([T('00:00:40,000', '00:00:41,000', 'x')], []),
    [['00:00:40,000', '00:00:41,000', 'x']],
    'dropCuesInDeepSilence: no segments -> identity',
  );
}

// --- subtitleSegmentation: groupTokenCues（停顿/句末标点/长度聚合） ---
// 停顿 > 0.5s → 切分成两条
eq(
  groupTokenCues([
    T('00:00:00,000', '00:00:00,300', '你'),
    T('00:00:00,300', '00:00:00,600', '好'),
    T('00:00:02,000', '00:00:02,300', '世'),
    T('00:00:02,300', '00:00:02,600', '界'),
  ]),
  [
    ['00:00:00,000', '00:00:00,600', '你好'],
    ['00:00:02,000', '00:00:02,600', '世界'],
  ],
  'group: gap > 0.5s splits into two cues',
);
// 句末标点 → 收尾当前 cue（标点保留在末尾）
eq(
  groupTokenCues([
    T('00:00:00,000', '00:00:00,300', '你'),
    T('00:00:00,300', '00:00:00,600', '好'),
    T('00:00:00,600', '00:00:00,900', '。'),
    T('00:00:00,900', '00:00:01,200', '下'),
    T('00:00:01,200', '00:00:01,500', '句'),
  ]),
  [
    ['00:00:00,000', '00:00:00,900', '你好。'],
    ['00:00:00,900', '00:00:01,500', '下句'],
  ],
  'group: sentence-end punctuation flushes the cue',
);
// 纯标点 token 不因宽度上限被单切（附在相邻 cue 末尾）
eq(
  groupTokenCues(
    [
      T('00:00:00,000', '00:00:00,300', '好'),
      T('00:00:00,300', '00:00:00,600', '。'),
    ],
    { maxWidth: 2 },
  ),
  [['00:00:00,000', '00:00:00,600', '好。']],
  'group: punct-only token is not split out by maxWidth',
);
// 对照：非标点字符在 maxWidth=2 下确实会被切（证明宽度闸生效、标点是豁免项）
eq(
  groupTokenCues(
    [
      T('00:00:00,000', '00:00:00,300', '好'),
      T('00:00:00,300', '00:00:00,600', '人'),
    ],
    { maxWidth: 2 },
  ),
  [
    ['00:00:00,000', '00:00:00,300', '好'],
    ['00:00:00,300', '00:00:00,600', '人'],
  ],
  'group: non-punct char splits at maxWidth (contrast)',
);
// 空输入 → 空输出
eq(groupTokenCues([]), [], 'group: empty input -> empty output');

// --- subtitleSegmentation: 任务级最大字数设置与重断句 ---
eq(
  getSubtitleCueOptions({ maxSubtitleChars: 0 }),
  undefined,
  'splitConfig: 0 keeps engine default',
);
eq(
  getSubtitleCueOptions({ maxSubtitleChars: 20 }),
  { maxWidth: 20, softMaxWidth: 12 },
  'splitConfig: positive maxSubtitleChars maps to cue width options',
);
eq(
  getSubtitleCueOptions({ maxSubtitleChars: 3 }),
  { maxWidth: 8, softMaxWidth: 6 },
  'splitConfig: user value is clamped to readable minimum',
);
eq(
  groupTokenCues(
    wordsToTriples([
      { start: 0, end: 0.3, word: 'Hello ' },
      { start: 0.3, end: 0.6, word: 'world ' },
      { start: 0.6, end: 0.9, word: 'again ' },
      { start: 0.9, end: 1.2, word: 'today' },
    ]),
    { maxWidth: 12, softMaxWidth: 8 },
  ),
  [
    ['00:00:00,000', '00:00:00,600', 'Hello world'],
    ['00:00:00,600', '00:00:01,200', 'again today'],
  ],
  'splitConfig: word-level timestamps rebuild long English subtitles by width',
);
eq(
  resplitSubtitleCues([T('0', '5', '一二三四五六七八九十')], {
    maxSubtitleChars: 8,
  }),
  [
    ['00:00:00,000', '00:00:02,000', '一二三四'],
    ['00:00:02,000', '00:00:04,000', '五六七八'],
    ['00:00:04,000', '00:00:05,000', '九十'],
  ],
  'splitConfig: segment-level fallback splits long CJK cue proportionally',
);
// 文本级兜底与 token 级硬切回溯共享同一份可断标点（含顿号）：切在「、」后而非句中。
eq(
  resplitSubtitleCues([T('0', '8', '一二、三四五六七')], {
    maxSubtitleChars: 8,
  }),
  [
    ['00:00:00,000', '00:00:03,000', '一二、'],
    ['00:00:03,000', '00:00:07,000', '三四五六'],
    ['00:00:07,000', '00:00:08,000', '七'],
  ],
  'splitConfig: text fallback breaks after dunhao (shared punct set)',
);
// composeWordCues 统一出口：词级三元组 + 任务级上限 → group(含硬切回溯)+merge+minDisplay。
eq(
  composeWordCues(
    wordsToTriples([
      { start: 0, end: 0.3, word: 'Hello ' },
      { start: 0.3, end: 0.6, word: 'world ' },
      { start: 0.6, end: 0.9, word: 'again ' },
      { start: 0.9, end: 1.2, word: 'today' },
    ]),
    { maxSubtitleChars: 12 },
  ),
  [
    ['00:00:00,000', '00:00:00,600', 'Hello world'],
    ['00:00:00,600', '00:00:01,200', 'again today'],
  ],
  'splitConfig: composeWordCues applies user width on word timestamps',
);
// 未设上限（0/缺省）→ 引擎默认断句（单条，不受用户宽度影响）。
eq(
  composeWordCues(
    wordsToTriples([
      { start: 0, end: 0.3, word: 'Hello ' },
      { start: 0.3, end: 0.6, word: 'world ' },
      { start: 0.6, end: 0.9, word: 'again ' },
      { start: 0.9, end: 1.2, word: 'today' },
    ]),
    { maxSubtitleChars: 0 },
  ),
  [['00:00:00,000', '00:00:01,200', 'Hello world again today']],
  'splitConfig: composeWordCues keeps engine defaults when limit unset',
);

// --- subtitleSegmentation: 硬切回溯到最近可断标点（避免孤立句尾词） ---
// 宽度超限时不在「当前词前」切，而是回溯到 cue 内最后一个可断标点后切；
// 余部（真实词级时间）作新 cue 开头。「甲乙，丙」+丁 超宽 → 「甲乙，」|「丙丁戊」。
eq(
  groupTokenCues(
    [
      T('0', '0.3', '甲'),
      T('0.3', '0.6', '乙'),
      T('0.6', '0.9', '，'),
      T('0.9', '1.2', '丙'),
      T('1.2', '1.5', '丁'),
      T('1.5', '1.8', '戊'),
    ],
    { maxWidth: 8 },
  ),
  [
    ['00:00:00,000', '00:00:00,900', '甲乙，'],
    ['00:00:00,900', '00:00:01,800', '丙丁戊'],
  ],
  'group: hard-cut backtracks to last breakable punct (comma)',
);
// 顿号不参与软切（枚举保护），但硬切被迫分割时参与回溯——切在顿号后优于切在词中。
eq(
  groupTokenCues(
    [
      T('0', '0.3', '甲'),
      T('0.3', '0.6', '乙'),
      T('0.6', '0.9', '、'),
      T('0.9', '1.2', '丙'),
      T('1.2', '1.5', '丁'),
      T('1.5', '1.8', '戊'),
    ],
    { maxWidth: 8 },
  ),
  [
    ['00:00:00,000', '00:00:00,900', '甲乙、'],
    ['00:00:00,900', '00:00:01,800', '丙丁戊'],
  ],
  'group: hard-cut backtracks at dunhao (excluded from soft cut only)',
);
// 句内无可断标点 → 与回溯前行为一致（在当前词前切）。
eq(
  groupTokenCues(
    [
      T('0', '0.3', '甲'),
      T('0.3', '0.6', '乙'),
      T('0.6', '0.9', '丙'),
      T('0.9', '1.2', '丁'),
      T('1.2', '1.5', '戊'),
    ],
    { maxWidth: 8 },
  ),
  [
    ['00:00:00,000', '00:00:01,200', '甲乙丙丁'],
    ['00:00:01,200', '00:00:01,500', '戊'],
  ],
  'group: hard-cut without punct falls back to cut-before-token',
);
// 余部并入本 token 后仍超宽 → 余部单独成条（任何 cue 不超宽；单字余部交 mergeShortCues 回收）。
eq(
  groupTokenCues(
    [
      T('0', '0.3', '甲'),
      T('0.3', '0.6', '，'),
      T('0.6', '0.9', '乙'),
      T('0.9', '1.2', '丙丙丙丙'),
    ],
    { maxWidth: 8 },
  ),
  [
    ['00:00:00,000', '00:00:00,600', '甲，'],
    ['00:00:00,600', '00:00:00,900', '乙'],
    ['00:00:00,900', '00:00:01,200', '丙丙丙丙'],
  ],
  'group: rest still over limit -> rest flushed alone (never overflow)',
);
// 英文（拉丁词带前置空格）同样回溯：逗号后分割，余部起点取真实词时间。
eq(
  groupTokenCues(
    [
      T('0', '0.35', ' aaaa'),
      T('0.4', '0.75', ' bb,'),
      T('0.8', '1.15', ' cc'),
      T('1.2', '1.55', ' dddd'),
    ],
    { maxWidth: 12 },
  ),
  [
    ['00:00:00,000', '00:00:00,750', 'aaaa bb,'],
    ['00:00:00,800', '00:00:01,550', 'cc dddd'],
  ],
  'group: hard-cut backtracks at latin comma with real word times',
);
// 真实回归（ASR ZH Longgap 阿里云词级结果原样）：整句超 20 汉字且句内仅有顿号 →
// 回溯到顿号切，不再产出孤立的「广泛。」尾词条。
eq(
  groupTokenCues([
    T('44.701', '45.212', '语音'),
    T('45.212', '45.722', '识别、'),
    T('45.722', '46.743', '机器翻译'),
    T('46.743', '46.998', '和'),
    T('46.998', '48.018', '自然语言'),
    T('48.018', '48.529', '处理'),
    T('48.529', '49.039', '应用'),
    T('49.039', '49.549', '十分'),
    T('49.549', '50.060', '广泛。'),
  ]),
  [
    ['00:00:44,701', '00:00:45,722', '语音识别、'],
    ['00:00:45,722', '00:00:50,060', '机器翻译和自然语言处理应用十分广泛。'],
  ],
  'group: real aliyun longgap sentence splits at dunhao, no orphan tail word',
);

// --- subtitleSegmentation: §6.2 标点优先软切 + 前导标点归属 ---
// 软切：cue 达软宽度后，在停顿性标点（，）处断句（softMaxWidth 默认 10）。
// 「今天是晴天」=10 + 「，」 → 收尾；「心情好」另起一条。
eq(
  groupTokenCues([
    T('0', '0.3', '今'),
    T('0.3', '0.6', '天'),
    T('0.6', '0.9', '是'),
    T('0.9', '1.2', '晴'),
    T('1.2', '1.5', '天'),
    T('1.5', '1.8', '，'),
    T('1.8', '2.1', '心'),
    T('2.1', '2.4', '情'),
    T('2.4', '2.7', '好'),
  ]),
  [
    ['00:00:00,000', '00:00:01,800', '今天是晴天，'],
    ['00:00:01,800', '00:00:02,700', '心情好'],
  ],
  'group(§6.2): soft-split at comma once cue reaches soft width',
);
// 不过碎：未达软宽度的短逗号短语保持一条（「好，的」宽度 5 < 10，不软切）。
eq(
  groupTokenCues([
    T('0', '0.3', '好'),
    T('0.3', '0.6', '，'),
    T('0.6', '0.9', '的'),
  ]),
  [['00:00:00,000', '00:00:00,900', '好，的']],
  'group(§6.2): short comma phrase below soft width stays one cue',
);
// 顿号保护：「、」不参与软切，电话号/枚举不被切碎（宽度已 > softMaxWidth 仍不切）。
eq(
  groupTokenCues([
    T('0', '0.3', '壹'),
    T('0.3', '0.6', '贰'),
    T('0.6', '0.9', '叁'),
    T('0.9', '1.2', '肆'),
    T('1.2', '1.5', '伍'),
    T('1.5', '1.8', '、'),
    T('1.8', '2.1', '陆'),
    T('2.1', '2.4', '柒'),
  ]),
  [['00:00:00,000', '00:00:02,400', '壹贰叁肆伍、陆柒']],
  'group(§6.2): ideographic comma does NOT trigger soft-split (keeps numbers/lists intact)',
);
// 软切（时长闸）：宽度不够但时长达 softMaxDuration（2.5s）后遇逗号也切。
eq(
  groupTokenCues([
    T('0', '1.4', '啊'),
    T('1.4', '2.8', '，'),
    T('2.8', '3.2', '好'),
  ]),
  [
    ['00:00:00,000', '00:00:02,800', '啊，'],
    ['00:00:02,800', '00:00:03,200', '好'],
  ],
  'group(§6.2): soft-split by duration gate when width is small',
);
// 前导标点归属：gap 后以标点开头的 token → 贴回上一条末尾，不另起以「，」开头的条。
eq(
  groupTokenCues([
    T('0', '0.3', '甲'),
    T('0.3', '0.6', '乙'),
    T('2.0', '2.3', '，'),
    T('2.3', '2.6', '丙'),
    T('2.6', '2.9', '丁'),
  ]),
  [
    ['00:00:00,000', '00:00:00,600', '甲乙，'],
    ['00:00:02,300', '00:00:02,900', '丙丁'],
  ],
  'group(§6.2): leading punctuation after a gap attaches to previous cue',
);
// 软切不影响句末标点：句末标点仍立即切（与软宽度无关）。
eq(
  groupTokenCues([
    T('0', '0.3', '好'),
    T('0.3', '0.6', '。'),
    T('0.6', '0.9', '走'),
  ]),
  [
    ['00:00:00,000', '00:00:00,600', '好。'],
    ['00:00:00,600', '00:00:00,900', '走'],
  ],
  'group(§6.2): sentence-end still flushes immediately regardless of soft width',
);

// --- subtitleSegmentation: tokensToTriples + group 端到端（原生 segment-aware token 已带停顿） ---
{
  // 原生层已把段间静音映射成 token gap（前段止于 2.0s、后段起于 12.0s）→ group 在此 gap 切两条，
  // 停顿天然复现（取代旧 retime+group：不再需要外部语音段把 token 贴回有声区间）。
  const native = [
    { text: '前', t0: 0, t1: 1000 },
    { text: '段', t0: 1000, t1: 2000 },
    { text: '后', t0: 12000, t1: 12300 },
    { text: '段', t0: 12300, t1: 12600 },
  ];
  eq(
    groupTokenCues(tokensToTriples(native)),
    [
      ['00:00:00,000', '00:00:02,000', '前段'],
      ['00:00:12,000', '00:00:12,600', '后段'],
    ],
    'tokensToTriples+group: native segment-aware gap splits into two cues',
  );
}

// --- subtitleSegmentation: mergeShortCues（弱模型/VAD 误切的单字碎片并回相邻条，§6.2 D10） ---
{
  // 复现用户反馈：「廣」「泛」被亚秒级假停顿切成单字两条 → 并回一条「廣泛。」
  eq(
    mergeShortCues([
      T('00:00:49,000', '00:00:49,300', '廣'),
      T('00:00:49,900', '00:00:50,200', '泛。'),
    ]),
    [['00:00:49,000', '00:00:50,200', '廣泛。']],
    'merge: single-char fragments across sub-second false gap join into previous',
  );
  // 真实停顿（数秒）隔开的短 cue → 不并（不跨越真实停顿桥接）
  eq(
    mergeShortCues([
      T('00:00:10,000', '00:00:10,300', '好'),
      T('00:00:15,000', '00:00:15,300', '走'),
    ]),
    [
      ['00:00:10,000', '00:00:10,300', '好'],
      ['00:00:15,000', '00:00:15,300', '走'],
    ],
    'merge: short cues separated by a real (multi-second) pause are kept',
  );
  // 足够宽的正常 cue → 原样（仅碎片才并）
  eq(
    mergeShortCues([
      T('00:00:00,000', '00:00:01,000', '大家好'),
      T('00:00:01,000', '00:00:02,000', '歡迎使用'),
    ]),
    [
      ['00:00:00,000', '00:00:01,000', '大家好'],
      ['00:00:01,000', '00:00:02,000', '歡迎使用'],
    ],
    'merge: cues at/above minWidth are left untouched',
  );
  // 连续多个单字碎片 → 级联并入同一条
  eq(
    mergeShortCues([
      T('0', '0.3', '一'),
      T('0.5', '0.8', '二'),
      T('1.0', '1.3', '三'),
    ]),
    [['00:00:00,000', '00:00:01,300', '一二三']],
    'merge: consecutive single-char fragments cascade into one cue',
  );
  // 首条即碎片且无上一条 → 原样保留（无处可并）
  eq(
    mergeShortCues([T('0', '0.3', '甲')]),
    [['00:00:00,000', '00:00:00,300', '甲']],
    'merge: leading lone fragment with no previous cue kept as-is',
  );
  // 并入后会超 maxWidth → 不并，保留碎片（避免超长 cue）
  eq(
    mergeShortCues([T('0', '1.0', '滿'), T('1.1', '1.4', '字')], {
      minContentChars: 1,
      maxWidth: 2,
    }),
    [
      ['00:00:00,000', '00:00:01,000', '滿'],
      ['00:00:01,100', '00:00:01,400', '字'],
    ],
    'merge: skip when joined width would exceed maxWidth',
  );
}

// --- subtitleSegmentation: enforceMinDisplayDuration（最短可读显示时长护栏，D15） ---
{
  // 过短 cue（0.5s < 0.8 硬下限）→ 末点延进其后空隙到 0.8s；够长的下一条不动
  eq(
    enforceMinDisplayDuration([
      T('00:00:10,000', '00:00:10,500', '短'),
      T('00:00:13,000', '00:00:16,000', '這是一條足夠長的字幕'),
    ]),
    [
      ['00:00:10,000', '00:00:10,800', '短'],
      ['00:00:13,000', '00:00:16,000', '這是一條足夠長的字幕'],
    ],
    'minDisplay: too-short cue end extended into following gap (hard floor)',
  );
  // 文本长但时长短（JA 实测 19~22 字 0.5s）→ 按实义字符数缩放 desired=20×0.06=1.2s
  const longCjk = 'あ'.repeat(20);
  eq(
    enforceMinDisplayDuration([
      T('00:00:10,000', '00:00:10,400', longCjk),
      T('00:00:14,000', '00:00:17,000', '後文'),
    ]),
    [
      ['00:00:10,000', '00:00:11,200', longCjk],
      ['00:00:14,000', '00:00:17,000', '後文'],
    ],
    'minDisplay: long-text short-duration cue scaled by content char count',
  );
  // 延长封顶在「下一条起点 − guardGap(0.1)」（EN 实测下一条很近 → 只能部分改善）
  eq(
    enforceMinDisplayDuration([
      T('00:00:40,000', '00:00:40,280', '字幕'),
      T('00:00:40,600', '00:00:42,000', '後面一條較長字幕'),
    ]),
    [
      ['00:00:40,000', '00:00:40,500', '字幕'],
      ['00:00:40,600', '00:00:42,000', '後面一條較長字幕'],
    ],
    'minDisplay: extension capped at next-start minus guard gap',
  );
  // 下一条过近（无空隙可延）→ 原样，绝不与下一条重叠
  eq(
    enforceMinDisplayDuration([
      T('00:00:40,000', '00:00:40,500', '字幕'),
      T('00:00:40,550', '00:00:42,000', '緊鄰下一條'),
    ]),
    [
      ['00:00:40,000', '00:00:40,500', '字幕'],
      ['00:00:40,550', '00:00:42,000', '緊鄰下一條'],
    ],
    'minDisplay: next cue too close leaves cue unchanged (no overlap)',
  );
  // 末条（其后无可解析起点）→ 不延长（纯函数无音频总长，交给 trim 兜底）
  eq(
    enforceMinDisplayDuration([T('00:00:10,000', '00:00:10,300', '短')]),
    [['00:00:10,000', '00:00:10,300', '短']],
    'minDisplay: last cue not extended (pure fn has no audio length)',
  );
  // 空输入 → 空
  eq(
    enforceMinDisplayDuration([]),
    [],
    'minDisplay: empty input returns empty',
  );
  // 已足够长的 cue → 仅规范化时间，不延长
  eq(
    enforceMinDisplayDuration([T('5', '8.5', '足夠長')]),
    [['00:00:05,000', '00:00:08,500', '足夠長']],
    'minDisplay: already-long cue normalized but not extended',
  );
  // 时间不可解析 → 原样返回（不臆断）
  eq(
    enforceMinDisplayDuration([T('bad', 'x', 'y')]),
    [['bad', 'x', 'y']],
    'minDisplay: unparseable cue returned as-is',
  );
  // perCharSeconds=0 关闭按长度缩放 → 仅用硬下限 0.8s（20 字也只到 0.8s）
  eq(
    enforceMinDisplayDuration(
      [
        T('00:00:10,000', '00:00:10,400', longCjk),
        T('00:00:14,000', '00:00:17,000', '後文'),
      ],
      { perCharSeconds: 0 },
    ),
    [
      ['00:00:10,000', '00:00:10,800', longCjk],
      ['00:00:14,000', '00:00:17,000', '後文'],
    ],
    'minDisplay: perCharSeconds=0 uses only the hard floor',
  );
  // 可配置硬下限（minDurationSeconds=1.5）
  eq(
    enforceMinDisplayDuration(
      [
        T('00:00:10,000', '00:00:10,500', '短'),
        T('00:00:20,000', '00:00:23,000', '後'),
      ],
      { minDurationSeconds: 1.5 },
    ),
    [
      ['00:00:10,000', '00:00:11,500', '短'],
      ['00:00:20,000', '00:00:23,000', '後'],
    ],
    'minDisplay: configurable minDurationSeconds floor',
  );
}

// --- outcomePresets: 字幕效果档位 → 引擎差异化底层参数 ---
{
  const pick = (
    s: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> =>
    keys.reduce((o, k) => ((o[k] = s[k]), o), {} as Record<string, unknown>);

  // builtin（whisper.cpp）：映射 useVAD / maxContext / reduceRepetition
  eq(
    pick(
      resolveEffectiveSettings(
        { transcriptionEngine: 'builtin', subtitleOutcome: 'accurate' },
        {},
      ),
      ['useVAD', 'maxContext', 'reduceRepetition'],
    ),
    { useVAD: false, maxContext: -1, reduceRepetition: false },
    'outcome/builtin: accurate → VAD off, ctx -1, repetition off',
  );
  eq(
    pick(
      resolveEffectiveSettings(
        { transcriptionEngine: 'builtin', subtitleOutcome: 'balanced' },
        {},
      ),
      ['useVAD', 'maxContext', 'reduceRepetition'],
    ),
    { useVAD: true, maxContext: -1, reduceRepetition: false },
    'outcome/builtin: balanced → VAD on, ctx -1, repetition off',
  );
  eq(
    pick(
      resolveEffectiveSettings(
        { transcriptionEngine: 'builtin', subtitleOutcome: 'clean' },
        {},
      ),
      ['useVAD', 'maxContext', 'reduceRepetition'],
    ),
    { useVAD: true, maxContext: 0, reduceRepetition: true },
    'outcome/builtin: clean → VAD on, ctx 0, repetition on',
  );

  // faster-whisper：accurate 仍开 VAD（与 builtin 不同），clean 开抗重复
  eq(
    resolveEffectiveSettings(
      { transcriptionEngine: 'fasterWhisper', subtitleOutcome: 'accurate' },
      {},
    ).useVAD,
    true,
    'outcome/fw: accurate keeps VAD on (≠ builtin)',
  );
  eq(
    resolveEffectiveSettings(
      { transcriptionEngine: 'fasterWhisper', subtitleOutcome: 'clean' },
      {},
    ).reduceRepetition,
    true,
    'outcome/fw: clean → reduceRepetition on',
  );

  // sherpa（funasr/qwen/fireRedAsr）：只映射 VAD 灵敏度，绝不关 VAD / 设 ctx / 抗重复
  const sherpaAccurate = resolveEffectiveSettings(
    { transcriptionEngine: 'funasr', subtitleOutcome: 'accurate' },
    {},
  );
  eq(
    pick(sherpaAccurate, [
      'vadThreshold',
      'vadMinSpeechDuration',
      'vadMinSilenceDuration',
      'vadMaxSpeechDuration',
    ]),
    {
      vadThreshold: 0.35,
      vadMinSpeechDuration: 100,
      vadMinSilenceDuration: 100,
      vadMaxSpeechDuration: 0,
    },
    'outcome/sherpa: accurate → VAD sensitive (Quiet)',
  );
  eq(
    sherpaAccurate.maxContext,
    undefined,
    'outcome/sherpa: accurate does NOT set maxContext',
  );
  eq(
    sherpaAccurate.reduceRepetition,
    undefined,
    'outcome/sherpa: accurate does NOT set reduceRepetition',
  );
  eq(
    resolveEffectiveSettings(
      { transcriptionEngine: 'qwen', subtitleOutcome: 'clean' },
      {},
    ).vadThreshold,
    0.65,
    'outcome/sherpa(qwen): clean → VAD conservative (Noisy) threshold',
  );
  eq(
    resolveEffectiveSettings(
      { transcriptionEngine: 'fireRedAsr', subtitleOutcome: 'balanced' },
      {},
    ).vadThreshold,
    0.5,
    'outcome/sherpa(fireRed): balanced → VAD standard threshold',
  );

  // custom 档：回读用户底层值（builtin 从 formData.maxContext 取）
  eq(
    resolveEffectiveSettings(
      {
        transcriptionEngine: 'builtin',
        subtitleOutcome: 'custom',
        maxContext: 7,
      },
      { useVAD: false, reduceRepetition: true },
    ),
    {
      useVAD: false,
      reduceRepetition: true,
      maxContext: 7,
    },
    'outcome/custom: passthrough user knobs + formData.maxContext',
  );

  // custom 档（B）：useVAD / reduceRepetition 改为任务级（formData）优先，覆盖全局，
  // 任务间互不污染；缺省时回落全局（老任务迁移行为不变）。
  eq(
    resolveEffectiveSettings(
      {
        transcriptionEngine: 'builtin',
        subtitleOutcome: 'custom',
        useVAD: false,
      },
      { useVAD: true },
    ).useVAD,
    false,
    'outcome/custom: task-level useVAD=false overrides global true',
  );
  eq(
    resolveEffectiveSettings(
      {
        transcriptionEngine: 'builtin',
        subtitleOutcome: 'custom',
        useVAD: true,
      },
      { useVAD: false },
    ).useVAD,
    true,
    'outcome/custom: task-level useVAD=true overrides global false',
  );
  eq(
    resolveEffectiveSettings(
      {
        transcriptionEngine: 'builtin',
        subtitleOutcome: 'custom',
        reduceRepetition: true,
      },
      { reduceRepetition: false },
    ).reduceRepetition,
    true,
    'outcome/custom: task-level reduceRepetition=true overrides global false',
  );
  eq(
    resolveEffectiveSettings(
      { transcriptionEngine: 'builtin', subtitleOutcome: 'custom' },
      { useVAD: false, reduceRepetition: true },
    ).useVAD,
    false,
    'outcome/custom: missing task-level useVAD → falls back to global',
  );

  // 不回写/不污染：resolver 不可变更入参对象
  {
    const settings = { useVAD: true, vadThreshold: 0.5 };
    const frozen = JSON.stringify(settings);
    resolveEffectiveSettings(
      { transcriptionEngine: 'funasr', subtitleOutcome: 'clean' },
      settings,
    );
    eq(
      JSON.stringify(settings),
      frozen,
      'outcome: resolver does not mutate input settings (no global pollution)',
    );
  }

  // inferSubtitleOutcome（迁移惰性反推，design D7）
  eq(inferSubtitleOutcome({}), 'balanced', 'infer: defaults → balanced');
  eq(
    inferSubtitleOutcome({
      useVAD: true,
      maxContext: -1,
      reduceRepetition: false,
    }),
    'balanced',
    'infer: explicit balanced shape',
  );
  eq(
    inferSubtitleOutcome({
      useVAD: true,
      maxContext: 0,
      reduceRepetition: true,
    }),
    'clean',
    'infer: clean shape',
  );
  eq(
    inferSubtitleOutcome({ useVAD: false }),
    'custom',
    'infer: VAD off → custom (no behavior change)',
  );
  eq(
    inferSubtitleOutcome({ maxContext: 5 }),
    'custom',
    'infer: nonstandard maxContext → custom',
  );

  // getSubtitleOutcome（运行时生效档）取值优先级：formData > 全局 > custom（绝不反推）
  eq(
    getSubtitleOutcome(
      { subtitleOutcome: 'clean' },
      { subtitleOutcome: 'accurate' },
    ),
    'clean',
    'getOutcome: task formData wins',
  );
  eq(
    getSubtitleOutcome({}, { subtitleOutcome: 'accurate' }),
    'accurate',
    'getOutcome: falls back to global default',
  );
  eq(
    getSubtitleOutcome(
      {},
      { useVAD: true, maxContext: 0, reduceRepetition: true },
    ),
    'custom',
    'getOutcome: no explicit → custom (migration-safe, never infers)',
  );
  eq(
    getSubtitleOutcome({}, {}),
    'custom',
    'getOutcome: fresh/absent → custom (= balanced-equivalent via defaults)',
  );

  // inferDisplayOutcome（UI 显示默认）：显式优先；否则叠加任务级 maxContext 反推
  eq(
    inferDisplayOutcome({}, {}),
    'balanced',
    'displayOutcome: fresh defaults → balanced',
  );
  eq(
    inferDisplayOutcome({ subtitleOutcome: 'accurate' }, {}),
    'accurate',
    'displayOutcome: explicit wins',
  );
  eq(
    inferDisplayOutcome(
      { maxContext: 0 },
      { useVAD: true, reduceRepetition: true },
    ),
    'clean',
    'displayOutcome: task maxContext=0 + global reduceRepetition → clean',
  );
  eq(
    inferDisplayOutcome(
      { maxContext: 0 },
      { useVAD: true, reduceRepetition: false },
    ),
    'custom',
    'displayOutcome: task maxContext=0 alone (no reduceRepetition) → custom (no false balanced)',
  );

  // 引擎归类断言
  eq(isSherpaEngineId('funasr'), true, 'isSherpa: funasr');
  eq(isSherpaEngineId('qwen'), true, 'isSherpa: qwen');
  eq(isSherpaEngineId('fireRedAsr'), true, 'isSherpa: fireRedAsr');
  eq(isSherpaEngineId('builtin'), false, 'isSherpa: builtin no');
  eq(isSherpaEngineId('fasterWhisper'), false, 'isSherpa: fasterWhisper no');
  eq(
    outcomeSupportsContextKnobs('builtin'),
    true,
    'ctxKnobs: builtin supports ctx/repetition',
  );
  eq(
    outcomeSupportsContextKnobs('funasr'),
    false,
    'ctxKnobs: sherpa hides ctx/repetition',
  );
}

// ===========================================================================
// 云端听写（Cloud ASR）：服务商解析 / 切片边界 / 词级映射与降级（纯逻辑）
// ===========================================================================

// --- asrProvider: parseAsrModels ---
eq(
  parseAsrModels({ models: 'whisper-1, gpt-4o-transcribe' }),
  ['whisper-1', 'gpt-4o-transcribe'],
  'asr: parseAsrModels splits comma list',
);
eq(
  parseAsrModels({ models: 'whisper-1\ngpt-4o-transcribe\nwhisper-1' }),
  ['whisper-1', 'gpt-4o-transcribe'],
  'asr: parseAsrModels newline + dedupe',
);
eq(
  parseAsrModels({ models: ['a', ' b ', 'a'] }),
  ['a', 'b'],
  'asr: parseAsrModels array trims + dedupe',
);
eq(parseAsrModels({ models: '' }), [], 'asr: parseAsrModels empty -> []');
eq(parseAsrModels(undefined), [], 'asr: parseAsrModels undefined -> []');
eq(
  parseAsrModels({ models: 'a，b、c；d;e' }),
  ['a', 'b', 'c', 'd', 'e'],
  'asr: parseAsrModels tolerates full-width comma/enum/semicolon separators',
);

// --- asrProvider: 品牌型模型清单为枚举 options（UI 勾选/只读，不做自由文本） ---
eq(
  getAsrProviderType(ASR_ELEVENLABS)?.fields.find((f) => f.key === 'models')
    ?.options,
  ['scribe_v2', 'scribe_v1'],
  'asr: elevenlabs models are enumerable options (scribe_v2 first)',
);
eq(
  getAsrProviderType(ASR_ELEVENLABS)?.fields.find((f) => f.key === 'models')
    ?.defaultValue,
  'scribe_v2',
  'asr: elevenlabs default model scribe_v2 (v1 deprecated)',
);
eq(
  getAsrProviderType('deepgram')?.fields.find((f) => f.key === 'models')
    ?.options,
  ['nova-2', 'nova-3'],
  'asr: deepgram models are enumerable options',
);
eq(
  getAsrProviderType(ASR_VOLCENGINE)?.fields.find((f) => f.key === 'models')
    ?.options,
  ['bigmodel'],
  'asr: volcengine model fixed to single option (read-only in UI)',
);
eq(
  getAsrProviderType(ASR_OPENAI_COMPATIBLE)?.fields.find(
    (f) => f.key === 'models',
  )?.options,
  undefined,
  'asr: openaiCompatible models stay free-form (tag input)',
);
// tencent：models = 计费档位（standard/large），识别语言跟随任务原语言映射 engine_type。
{
  const tencentModels = getAsrProviderType(ASR_TENCENT)?.fields.find(
    (f) => f.key === 'models',
  );
  eq(
    tencentModels?.options,
    ['standard', 'large'],
    'asr: tencent models are billing tiers, not engine ids',
  );
  eq(
    tencentModels?.defaultValue,
    'standard',
    'asr: tencent default tier standard (cheaper, concurrency 20)',
  );
}
// aliyun：模型固定 flash（接口无模型参数，语种由 appkey 项目配置决定）。
{
  const aliyunModels = getAsrProviderType(ASR_ALIYUN)?.fields.find(
    (f) => f.key === 'models',
  );
  eq(
    aliyunModels?.options,
    ['flash'],
    'asr: aliyun model fixed to single option (read-only in UI)',
  );
  eq(aliyunModels?.defaultValue, 'flash', 'asr: aliyun default model flash');
  eq(
    getAsrProviderType(ASR_ALIYUN)?.fields.some((f) => f.key === 'apiUrl'),
    false,
    'asr: aliyun has no apiUrl field (fixed endpoints)',
  );
}
// xfyun：models = 语种档位（autodialect/autominor），识别语言免切自动。
{
  const xfyunModels = getAsrProviderType(ASR_XFYUN)?.fields.find(
    (f) => f.key === 'models',
  );
  eq(
    xfyunModels?.options,
    ['autodialect', 'autominor'],
    'asr: xfyun models are language tiers, not engine ids',
  );
  eq(
    xfyunModels?.defaultValue,
    'autodialect',
    'asr: xfyun default tier autodialect (autominor needs manual activation)',
  );
  eq(
    getAsrProviderType(ASR_XFYUN)?.fields.some((f) => f.key === 'apiUrl'),
    false,
    'asr: xfyun has no apiUrl field (fixed endpoint)',
  );
  eq(
    getAsrProviderType(ASR_XFYUN)?.fields.find(
      (f) => f.key === 'requestTimeoutSec',
    )?.defaultValue,
    300,
    'asr: xfyun request timeout defaults to 300s (async upload is slower)',
  );
}

// --- asrProvider: isAsrProviderConfigured (required = apiUrl/apiKey/models) ---
eq(
  isAsrProviderConfigured({
    id: '1',
    name: 'x',
    type: 'openaiCompatible',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-xxx',
    models: 'whisper-1',
  }),
  true,
  'asr: configured when all required present',
);
eq(
  isAsrProviderConfigured({
    id: '1',
    name: 'x',
    type: 'openaiCompatible',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: 'whisper-1',
  }),
  false,
  'asr: not configured when apiKey empty',
);
eq(
  isAsrProviderConfigured({
    id: '1',
    name: 'x',
    type: 'openaiCompatible',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk',
    models: '',
  }),
  false,
  'asr: not configured when models empty',
);
eq(
  isAsrProviderConfigured({
    id: '1',
    name: 'x',
    type: 'unknownType',
    apiKey: 'sk',
  }),
  false,
  'asr: unknown type -> not configured',
);
// volcengine：新版控制台单 API Key（标准 apiKey 字段）
eq(
  isAsrProviderConfigured({
    id: 'v1',
    name: 'volc',
    type: ASR_VOLCENGINE,
    apiKey: 'volc-api-key',
    models: 'bigmodel',
    apiUrl: 'https://openspeech.bytedance.com',
  }),
  true,
  'asr: volcengine ready with apiKey',
);
eq(
  isAsrProviderConfigured({
    id: 'v1',
    name: 'volc',
    type: ASR_VOLCENGINE,
    apiKey: '',
    models: 'bigmodel',
    apiUrl: 'https://openspeech.bytedance.com',
  }),
  false,
  'asr: volcengine not ready without apiKey',
);
// tencent：三字段凭据（appid/secretId/secretKey），任缺未就绪。
eq(
  isAsrProviderConfigured({
    id: 't1',
    name: 'tencent',
    type: ASR_TENCENT,
    appid: '1300000000',
    secretId: 'AKIDxxx',
    secretKey: 'sk',
    models: 'standard,large',
  }),
  true,
  'asr: tencent ready with appid + secretId + secretKey',
);
eq(
  isAsrProviderConfigured({
    id: 't1',
    name: 'tencent',
    type: ASR_TENCENT,
    appid: '1300000000',
    secretId: 'AKIDxxx',
    secretKey: '',
    models: 'standard',
  }),
  false,
  'asr: tencent not ready without secretKey',
);
eq(
  isAsrProviderConfigured({
    id: 't1',
    name: 'tencent',
    type: ASR_TENCENT,
    appid: '',
    secretId: 'AKIDxxx',
    secretKey: 'sk',
    models: 'standard',
  }),
  false,
  'asr: tencent not ready without appid',
);
// aliyun：三字段凭据（accessKeyId/accessKeySecret/appkey），任缺未就绪。
eq(
  isAsrProviderConfigured({
    id: 'a1',
    name: 'aliyun',
    type: ASR_ALIYUN,
    accessKeyId: 'LTAIxxx',
    accessKeySecret: 'secret',
    appkey: 'a3Hwxxxx',
    models: 'flash',
  }),
  true,
  'asr: aliyun ready with accessKeyId + accessKeySecret + appkey',
);
eq(
  isAsrProviderConfigured({
    id: 'a1',
    name: 'aliyun',
    type: ASR_ALIYUN,
    accessKeyId: 'LTAIxxx',
    accessKeySecret: 'secret',
    appkey: '',
    models: 'flash',
  }),
  false,
  'asr: aliyun not ready without appkey',
);
eq(
  isAsrProviderConfigured({
    id: 'a1',
    name: 'aliyun',
    type: ASR_ALIYUN,
    accessKeyId: '',
    accessKeySecret: 'secret',
    appkey: 'a3Hwxxxx',
    models: 'flash',
  }),
  false,
  'asr: aliyun not ready without accessKeyId',
);
// xfyun：三字段凭据（appid/apiKey/apiSecret），任缺未就绪。
eq(
  isAsrProviderConfigured({
    id: 'x1',
    name: 'xfyun',
    type: ASR_XFYUN,
    appid: '9f000000',
    apiKey: 'ak',
    apiSecret: 'as',
    models: 'autodialect',
  }),
  true,
  'asr: xfyun ready with appid + apiKey + apiSecret',
);
eq(
  isAsrProviderConfigured({
    id: 'x1',
    name: 'xfyun',
    type: ASR_XFYUN,
    appid: '9f000000',
    apiKey: 'ak',
    apiSecret: '',
    models: 'autodialect',
  }),
  false,
  'asr: xfyun not ready without apiSecret',
);
eq(
  isAsrProviderConfigured({
    id: 'x1',
    name: 'xfyun',
    type: ASR_XFYUN,
    appid: '',
    apiKey: 'ak',
    apiSecret: 'as',
    models: 'autodialect',
  }),
  false,
  'asr: xfyun not ready without appid',
);

// --- asrProvider: groupInstancesByType (面板分区数据源) ---
// 分区结构简化为 { id, insts:[实例id] } 便于断言（避免比对完整 type 对象）。
const groupShape = (
  gs: ReturnType<typeof groupInstancesByType>,
): Array<{ id: string; insts: string[] }> =>
  gs.map((g) => ({ id: g.type.id, insts: g.instances.map((i) => i.id) }));

const GT = [
  { id: 'a', name: 'A', fields: [] },
  { id: 'b', name: 'B', fields: [] },
];
eq(
  groupShape(
    groupInstancesByType(
      [
        { id: '1', name: 'x', type: 'a' },
        { id: '2', name: 'y', type: 'b' },
        { id: '3', name: 'z', type: 'a' },
      ],
      GT,
    ),
  ),
  [
    { id: 'a', insts: ['1', '3'] },
    { id: 'b', insts: ['2'] },
  ],
  'asr: groupInstancesByType groups by type in types order',
);
eq(
  groupShape(groupInstancesByType([{ id: '9', name: 'q', type: 'gone' }], GT)),
  [
    { id: 'a', insts: [] },
    { id: 'b', insts: [] },
    { id: 'gone', insts: ['9'] },
  ],
  'asr: groupInstancesByType appends unknown-type instances at end',
);
eq(
  groupShape(groupInstancesByType(undefined, GT)),
  [
    { id: 'a', insts: [] },
    { id: 'b', insts: [] },
  ],
  'asr: groupInstancesByType undefined -> all known types empty, no orphans',
);
eq(
  groupShape(groupInstancesByType([])).map((g) => g.id),
  ASR_PROVIDER_TYPES.map((t) => t.id),
  'asr: groupInstancesByType default types = ASR_PROVIDER_TYPES order',
);

// --- asrProvider: multiInstance flag (协议型 vs 品牌型) ---
eq(
  !!getAsrProviderType(ASR_OPENAI_COMPATIBLE)?.multiInstance,
  true,
  'asr: openaiCompatible is multiInstance (protocol-type)',
);
eq(
  !!getAsrProviderType(ASR_ELEVENLABS)?.multiInstance,
  false,
  'asr: elevenlabs is singleton (brand-type)',
);
eq(
  !!getAsrProviderType(ASR_VOLCENGINE)?.multiInstance,
  false,
  'asr: volcengine is singleton (brand-type)',
);
eq(
  groupShape(groupInstancesByType([])).some(
    (g) => g.id === ASR_VOLCENGINE && g.insts.length === 0,
  ),
  true,
  'asr: volcengine appears as empty group by default',
);
eq(
  !!getAsrProviderType(ASR_TENCENT)?.multiInstance,
  false,
  'asr: tencent is singleton (brand-type)',
);
eq(
  groupShape(groupInstancesByType([])).some(
    (g) => g.id === ASR_TENCENT && g.insts.length === 0,
  ),
  true,
  'asr: tencent appears as empty group by default',
);
// aliyun：品牌型硬单例（语种绑定 NLS 项目，换语种在控制台改项目配置）。
eq(
  !!getAsrProviderType(ASR_ALIYUN)?.multiInstance,
  false,
  'asr: aliyun is singleton (brand-type; language configured on console project)',
);
eq(
  groupShape(groupInstancesByType([])).some(
    (g) => g.id === ASR_ALIYUN && g.insts.length === 0,
  ),
  true,
  'asr: aliyun appears as empty group by default',
);
// xfyun：品牌型硬单例（固定官方端点，档位在 models 内选）。
eq(
  !!getAsrProviderType(ASR_XFYUN)?.multiInstance,
  false,
  'asr: xfyun is singleton (brand-type)',
);
eq(
  groupShape(groupInstancesByType([])).some(
    (g) => g.id === ASR_XFYUN && g.insts.length === 0,
  ),
  true,
  'asr: xfyun appears as empty group by default',
);

// --- asrProvider: resolveAudioLimits (类型声明覆盖全局默认) ---
const LIMIT_DEFAULTS = {
  maxUploadBytes: 23 * 1024 * 1024,
  maxChunkSeconds: 600,
};
eq(
  resolveAudioLimits(getAsrProviderType(ASR_VOLCENGINE), LIMIT_DEFAULTS),
  { maxUploadBytes: 16 * 1024 * 1024, maxChunkSeconds: 480 },
  'asr: volcengine declares tighter audio limits',
);
eq(
  resolveAudioLimits(getAsrProviderType(ASR_TENCENT), LIMIT_DEFAULTS),
  { maxUploadBytes: 24 * 1024 * 1024, maxChunkSeconds: 600 },
  'asr: tencent declares 24MB byte cap, chunk seconds fall back to defaults',
);
eq(
  resolveAudioLimits(getAsrProviderType(ASR_ALIYUN), LIMIT_DEFAULTS),
  { maxUploadBytes: 24 * 1024 * 1024, maxChunkSeconds: 600 },
  'asr: aliyun declares 24MB byte cap (same 100MB/2h rationale as tencent)',
);
eq(
  resolveAudioLimits(getAsrProviderType(ASR_XFYUN), LIMIT_DEFAULTS),
  { maxUploadBytes: 48 * 1024 * 1024, maxChunkSeconds: 600 },
  'asr: xfyun declares 48MB byte cap (~3.3h mp3, clamps 5h duration limit)',
);
eq(
  resolveAudioLimits(getAsrProviderType(ASR_OPENAI_COMPATIBLE), LIMIT_DEFAULTS),
  LIMIT_DEFAULTS,
  'asr: undeclared audioLimits -> global defaults',
);
eq(
  resolveAudioLimits(undefined, LIMIT_DEFAULTS),
  LIMIT_DEFAULTS,
  'asr: unknown type -> global defaults',
);

// --- asrProvider: getAsrPresetsForType (命名预设清单) ---
eq(
  getAsrPresetsForType(ASR_OPENAI_COMPATIBLE).map((p) => p.id),
  ['openai', 'groq', 'siliconflow'],
  'asr: openaiCompatible presets list',
);
eq(getAsrPresetsForType(ASR_ELEVENLABS), [], 'asr: brand type has no presets');
eq(getAsrPresetsForType('nope'), [], 'asr: unknown type -> no presets');
eq(getAsrPresetsForType(undefined), [], 'asr: undefined type -> no presets');

// --- asrProvider: buildInstanceFromPreset (预设覆盖类型默认) ---
const oaType = getAsrProviderType(ASR_OPENAI_COMPATIBLE)!;
const groqPreset = getAsrPresetsForType(ASR_OPENAI_COMPATIBLE).find(
  (p) => p.id === 'groq',
)!;
const groqInst = buildInstanceFromPreset(oaType, groqPreset, () => 'fixed1');
eq(
  {
    id: groqInst.id,
    name: groqInst.name,
    type: groqInst.type,
    apiUrl: groqInst.apiUrl,
    models: groqInst.models,
    requestTimeoutSec: groqInst.requestTimeoutSec,
    concurrency: groqInst.concurrency,
  },
  {
    id: 'fixed1',
    name: 'Groq',
    type: ASR_OPENAI_COMPATIBLE,
    apiUrl: 'https://api.groq.com/openai/v1',
    models: 'whisper-large-v3-turbo, whisper-large-v3',
    requestTimeoutSec: 120,
    concurrency: 4,
  },
  'asr: buildInstanceFromPreset applies preset over type defaults',
);
eq(
  isAsrProviderConfigured(groqInst),
  false,
  'asr: preset instance still needs apiKey (not ready until key set)',
);
const customInst = buildInstanceFromPreset(oaType, undefined, () => 'fixed2');
eq(
  {
    id: customInst.id,
    name: customInst.name,
    type: customInst.type,
    apiUrl: customInst.apiUrl,
    models: customInst.models,
  },
  {
    id: 'fixed2',
    name: 'OpenAI Compatible',
    type: ASR_OPENAI_COMPATIBLE,
    apiUrl: 'https://api.openai.com/v1',
    models: 'whisper-1',
  },
  'asr: buildInstanceFromPreset without preset = type defaults (custom)',
);

// --- cloudAudioChunking: computeChunkBoundaries ---
eq(
  computeChunkBoundaries([], 120, 600),
  [{ start: 0, end: 120 }],
  'chunk: no segments + duration -> single chunk',
);
eq(
  computeChunkBoundaries([], 0, 600),
  [],
  'chunk: no segments no duration -> []',
);
eq(
  computeChunkBoundaries(
    [
      { start: 0, end: 10 },
      { start: 12, end: 20 },
    ],
    20,
    600,
  ),
  [{ start: 0, end: 20 }],
  'chunk: within limit -> single chunk',
);
eq(
  computeChunkBoundaries(
    [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 12, end: 16 },
      { start: 18, end: 22 },
    ],
    22,
    10,
  ),
  [
    { start: 0, end: 10.5 },
    { start: 10.5, end: 17 },
    { start: 17, end: 22 },
  ],
  'chunk: exceeding limit splits at silence midpoints',
);

// --- cloudAsrShared: needsSpaceBefore ---
eq(needsSpaceBefore('Hello'), true, 'asr: latin word needs leading space');
eq(needsSpaceBefore('2026'), true, 'asr: digit word needs leading space');
eq(needsSpaceBefore('你'), false, 'asr: CJK word no leading space');
eq(needsSpaceBefore('，'), false, 'asr: punctuation no leading space');

// --- cloudAsrShared: wordsToNativeTokens (sec->ms, latin spacing) ---
eq(
  wordsToNativeTokens([
    { word: 'Hello', start: 0, end: 0.5 },
    { word: '你', start: 0.5, end: 0.8 },
  ]),
  [
    { text: ' Hello', t0: 0, t1: 500 },
    { text: '你', t0: 500, t1: 800 },
  ],
  'asr: wordsToNativeTokens maps ms + latin leading space',
);

// --- cloudAsrShared: realignPunctuation (best-effort punctuation reattach) ---
eq(
  realignPunctuation(
    [
      { word: '你', start: 0, end: 0.3 },
      { word: '好', start: 0.3, end: 0.6 },
      { word: '世', start: 0.6, end: 0.9 },
      { word: '界', start: 0.9, end: 1.2 },
    ],
    '你好，世界。',
  ).map((w) => w.word),
  ['你', '好，', '世', '界。'],
  'asr: realign reattaches mid + trailing CJK punctuation',
);
eq(
  realignPunctuation([{ word: 'x', start: 0, end: 1 }], '').map((w) => w.word),
  ['x'],
  'asr: realign with empty fullText is a no-op',
);

// --- cloudAsrShared: offsetWords ---
eq(
  offsetWords([{ word: 'a', start: 1, end: 2 }], 10),
  [{ word: 'a', start: 11, end: 12 }],
  'asr: offsetWords shifts by seconds',
);

// --- cloudAsrShared: wordCuesFromResult (word-level -> reuse builtin segmentation) ---
// 中文字级 + 停顿 → 断成两条；标点回贴；最短显示时长护栏延长首条。
eq(
  wordCuesFromResult({
    words: [
      { word: '你', start: 0, end: 0.3 },
      { word: '好', start: 0.3, end: 0.6 },
      { word: '世', start: 2.0, end: 2.3 },
      { word: '界', start: 2.3, end: 2.6 },
    ],
    text: '你好世界。',
  }),
  [
    ['00:00:00,000', '00:00:00,800', '你好'],
    ['00:00:02,000', '00:00:02,600', '世界。'],
  ],
  'asr: wordCues splits Chinese by pause + reattaches trailing punct',
);
// 英文子词拼接不加错空格（word 间空格由 latin 规则生成，非硬拼）。
eq(
  wordCuesFromResult({
    words: [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'world', start: 0.5, end: 1.0 },
    ],
    text: 'Hello world.',
  }),
  [['00:00:00,000', '00:00:01,000', 'Hello world.']],
  'asr: wordCues joins English words with single spaces',
);
// 云端词级路径接入任务级 maxSubtitleChars：与本地引擎同一统一出口（composeWordCues）。
eq(
  wordCuesFromResult(
    {
      words: [
        { word: 'Hello', start: 0, end: 0.3 },
        { word: 'world', start: 0.3, end: 0.6 },
        { word: 'again', start: 0.6, end: 0.9 },
        { word: 'today', start: 0.9, end: 1.2 },
      ],
      text: 'Hello world again today',
    },
    { maxSubtitleChars: 12 },
  ),
  [
    ['00:00:00,000', '00:00:00,600', 'Hello world'],
    ['00:00:00,600', '00:00:01,200', 'again today'],
  ],
  'asr: wordCues honors task-level maxSubtitleChars via shared exit',
);

// --- cloudAsrShared: segmentCuesFromSegments (degrade path, with offset) ---
eq(
  segmentCuesFromSegments(
    [
      { start: 0, end: 2, text: 'hi' },
      { start: 2, end: 2, text: 'empty-dur' },
      { start: 3, end: 5, text: '  spaced  ' },
    ],
    10,
  ),
  [
    ['00:00:10,000', '00:00:12,000', 'hi'],
    ['00:00:13,000', '00:00:15,000', 'spaced'],
  ],
  'asr: segmentCues applies offset + filters invalid/empty',
);

// --- cloudAsrShared: singleCueFromText ---
eq(
  singleCueFromText('全部文本', 0, 12),
  [['00:00:00,000', '00:00:12,000', '全部文本']],
  'asr: singleCueFromText spans whole range',
);
eq(
  singleCueFromText('x', 5, 5),
  [],
  'asr: singleCueFromText rejects non-positive span',
);

// --- openaiCompatUtils: normalizeBaseURL ---
eq(
  normalizeBaseURL('https://api.openai.com/v1'),
  'https://api.openai.com/v1',
  'asr: baseURL passthrough',
);
eq(
  normalizeBaseURL('https://api.openai.com/v1/'),
  'https://api.openai.com/v1',
  'asr: baseURL trailing slash stripped',
);
eq(
  normalizeBaseURL('https://api.openai.com/v1/audio/transcriptions'),
  'https://api.openai.com/v1',
  'asr: baseURL strips /audio/transcriptions suffix',
);
eq(
  (() => {
    try {
      normalizeBaseURL('ftp://x');
      return 'no-throw';
    } catch {
      return 'threw';
    }
  })(),
  'threw',
  'asr: baseURL rejects non-http(s)',
);

// --- openaiCompatUtils: normalizeLanguage ---
eq(normalizeLanguage('auto'), undefined, 'asr: language auto -> undefined');
eq(
  normalizeLanguage(undefined),
  undefined,
  'asr: language undefined -> undefined',
);
eq(normalizeLanguage('zh-CN'), 'zh', 'asr: language zh-CN -> zh');
eq(normalizeLanguage('EN'), 'en', 'asr: language EN -> en');

// --- openaiCompatUtils: mapWords (filters non-finite times) ---
eq(
  mapWords([
    { word: 'a', start: 0, end: 1 },
    { word: 'b', start: 'x', end: 2 },
  ]),
  [{ word: 'a', start: 0, end: 1 }],
  'asr: mapWords drops words with non-finite time',
);

// --- openaiCompatUtils: isVerboseUnsupportedError ---
eq(
  isVerboseUnsupportedError({ status: 400 }),
  true,
  'asr: 400 -> verbose unsupported',
);
eq(
  isVerboseUnsupportedError({ status: 422 }),
  true,
  'asr: 422 -> verbose unsupported',
);
eq(
  isVerboseUnsupportedError(new Error('timestamp_granularities not supported')),
  true,
  'asr: message match -> verbose unsupported',
);
eq(
  isVerboseUnsupportedError(new Error('network timeout')),
  false,
  'asr: unrelated error -> not verbose-unsupported',
);

// ===========================================================================
// ElevenLabs Scribe：Base URL 归一 / 端点拼接 / 词映射（过滤 spacing）/ 重试判定
// ===========================================================================

// --- elevenlabsUtils: normalizeElevenLabsBaseURL ---
eq(
  normalizeElevenLabsBaseURL(undefined),
  'https://api.elevenlabs.io/v1',
  'eleven: empty -> official default',
);
eq(
  normalizeElevenLabsBaseURL('   '),
  'https://api.elevenlabs.io/v1',
  'eleven: blank -> official default',
);
eq(
  normalizeElevenLabsBaseURL('ftp://bad'),
  'https://api.elevenlabs.io/v1',
  'eleven: non-http -> official default',
);
eq(
  normalizeElevenLabsBaseURL('https://proxy.example.com/v1/'),
  'https://proxy.example.com/v1',
  'eleven: strips trailing slash on proxy base',
);
eq(
  normalizeElevenLabsBaseURL('https://proxy.example.com/v1/speech-to-text'),
  'https://proxy.example.com/v1',
  'eleven: strips accidental /speech-to-text suffix',
);

// --- elevenlabsUtils: buildSpeechToTextURL ---
eq(
  buildSpeechToTextURL('https://api.elevenlabs.io/v1'),
  'https://api.elevenlabs.io/v1/speech-to-text',
  'eleven: builds speech-to-text endpoint',
);

// --- elevenlabsUtils: mapElevenLabsWords ---
eq(
  mapElevenLabsWords([
    { text: 'Hello', start: 0, end: 0.4, type: 'word' },
    { text: ' ', start: 0.4, end: 0.4, type: 'spacing' },
    { text: 'world', start: 0.4, end: 0.9, type: 'word' },
    { text: '[laughs]', start: 0.9, end: 1.2, type: 'audio_event' },
  ]),
  [
    { word: 'Hello', start: 0, end: 0.4 },
    { word: 'world', start: 0.4, end: 0.9 },
  ],
  'eleven: keeps word tokens, drops spacing + audio_event',
);
eq(
  mapElevenLabsWords([
    { text: '你好', start: 0, end: 0.5 },
    { text: '，', start: 0.5, end: 0.5 },
    { text: 'x', start: NaN, end: 1 },
  ]),
  [
    { word: '你好', start: 0, end: 0.5 },
    { word: '，', start: 0.5, end: 0.5 },
  ],
  'eleven: no-type kept; drops non-finite times',
);
eq(mapElevenLabsWords(null), [], 'eleven: non-array -> []');

// --- elevenlabsUtils: isRetriableStatus ---
eq(isRetriableStatus(429), true, 'eleven: 429 retriable');
eq(isRetriableStatus(503), true, 'eleven: 503 retriable');
eq(isRetriableStatus(400), false, 'eleven: 400 not retriable');
eq(isRetriableStatus(200), false, 'eleven: 200 not retriable');

// ===========================================================================
// Deepgram：Base URL 归一 / listen 查询拼接 / 词映射（punctuated_word 优先）/ 结果提取
// ===========================================================================

// --- deepgramUtils: normalizeDeepgramBaseURL ---
eq(
  normalizeDeepgramBaseURL(undefined),
  'https://api.deepgram.com/v1',
  'deepgram: empty -> official default',
);
eq(
  normalizeDeepgramBaseURL('https://proxy.example.com/v1/listen'),
  'https://proxy.example.com/v1',
  'deepgram: strips accidental /listen suffix',
);
eq(
  normalizeDeepgramBaseURL('ftp://bad'),
  'https://api.deepgram.com/v1',
  'deepgram: non-http -> official default',
);

// --- deepgramUtils: buildListenURL ---
eq(
  buildListenURL('https://api.deepgram.com/v1', {
    model: 'nova-2',
    language: 'en',
  }),
  'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&language=en',
  'deepgram: builds listen url with language',
);
eq(
  buildListenURL('https://api.deepgram.com/v1', { model: 'nova-2' }),
  'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&detect_language=true',
  'deepgram: no language -> detect_language=true',
);

// --- deepgramUtils: mapDeepgramWords (punctuated_word preferred) ---
eq(
  mapDeepgramWords([
    { word: 'hello', punctuated_word: 'Hello,', start: 0, end: 0.4 },
    { word: 'world', punctuated_word: 'world.', start: 0.4, end: 0.9 },
    { word: 'x', start: NaN, end: 1 },
  ]),
  [
    { word: 'Hello,', start: 0, end: 0.4 },
    { word: 'world.', start: 0.4, end: 0.9 },
  ],
  'deepgram: prefers punctuated_word, drops non-finite',
);
eq(
  mapDeepgramWords([{ word: 'plain', start: 1, end: 2 }]),
  [{ word: 'plain', start: 1, end: 2 }],
  'deepgram: falls back to word when no punctuated_word',
);

// --- deepgramUtils: extractDeepgramResult (nested structure) ---
eq(
  extractDeepgramResult({
    results: {
      channels: [
        {
          detected_language: 'en',
          alternatives: [
            {
              transcript: 'Hello world.',
              words: [
                { word: 'hello', punctuated_word: 'Hello', start: 0, end: 0.4 },
                {
                  word: 'world',
                  punctuated_word: 'world.',
                  start: 0.4,
                  end: 0.9,
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  {
    text: 'Hello world.',
    words: [
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'world.', start: 0.4, end: 0.9 },
    ],
    language: 'en',
  },
  'deepgram: extracts transcript + words + detected language',
);
eq(
  extractDeepgramResult({}),
  { text: '', words: [], language: undefined },
  'deepgram: empty response -> safe defaults',
);

// ===========================================================================
// 火山引擎豆包：Base URL 归一 / 新旧凭据 header / 请求体 / 状态码分类 / 结果提取
// ===========================================================================

// --- volcengineUtils: normalizeVolcBaseURL ---
eq(
  normalizeVolcBaseURL(undefined),
  'https://openspeech.bytedance.com',
  'volc: empty -> official default',
);
eq(
  normalizeVolcBaseURL(
    'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
  ),
  'https://openspeech.bytedance.com',
  'volc: strips accidental flash path suffix',
);
eq(
  normalizeVolcBaseURL('https://proxy.example.com/volc/'),
  'https://proxy.example.com/volc',
  'volc: keeps custom prefix path, trims trailing slash',
);
eq(
  normalizeVolcBaseURL('ftp://bad'),
  'https://openspeech.bytedance.com',
  'volc: non-http -> official default',
);

// --- volcengineUtils: buildVolcHeaders（新版控制台单 API Key） ---
eq(
  buildVolcHeaders('single-key', 'req-1'),
  {
    'X-Api-Key': 'single-key',
    'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
    'X-Api-Request-Id': 'req-1',
    'X-Api-Sequence': '-1',
    'Content-Type': 'application/json',
  },
  'volc: single API key -> X-Api-Key headers',
);
eq(
  buildVolcHeaders('  padded  ', 'req-2')['X-Api-Key'],
  'padded',
  'volc: api key trimmed',
);

// --- volcengineUtils: buildVolcRequestBody ---
eq(
  buildVolcRequestBody('QUJD', 'bigmodel'),
  {
    user: { uid: 'video-subtitle-master' },
    audio: { data: 'QUJD' },
    request: {
      model_name: 'bigmodel',
      enable_punc: true,
      enable_itn: true,
      enable_ddc: false,
      show_utterances: true,
    },
  },
  'volc: request body base64 direct + utterances on, ddc off',
);
eq(
  (buildVolcRequestBody('', '') as { request: { model_name: string } }).request
    .model_name,
  'bigmodel',
  'volc: empty model -> bigmodel default',
);

// --- volcengineUtils: classifyVolcStatus（X-Api-Status-Code 优先于 HTTP） ---
eq(classifyVolcStatus(200, '20000000'), 'success', 'volc: 20000000 success');
eq(
  classifyVolcStatus(200, '20000003'),
  'empty',
  'volc: 20000003 silent audio -> empty',
);
eq(classifyVolcStatus(401, null), 'auth', 'volc: HTTP 401 -> auth');
eq(classifyVolcStatus(403, '40300001'), 'auth', 'volc: HTTP 403 -> auth');
eq(
  classifyVolcStatus(200, '55000031'),
  'retriable',
  'volc: 55000031 overload -> retriable',
);
eq(
  classifyVolcStatus(200, '55012345'),
  'retriable',
  'volc: 550xxxxx internal error -> retriable',
);
eq(
  classifyVolcStatus(503, null),
  'retriable',
  'volc: HTTP 5xx without api code -> retriable',
);
eq(classifyVolcStatus(429, ''), 'retriable', 'volc: HTTP 429 -> retriable');
eq(
  classifyVolcStatus(200, '45000001'),
  'fatal',
  'volc: 45xxxxxx param error -> fatal',
);
eq(classifyVolcStatus(200, null), 'fatal', 'volc: no api code -> fatal');

// --- volcengineUtils: buildSilentWavBase64（连接自测的最小合法音频） ---
{
  const wav = Buffer.from(buildSilentWavBase64(1, 16000), 'base64');
  eq(wav.length, 44 + 16000 * 2, 'volc: 1s/16k silent wav byte length');
  eq(wav.toString('ascii', 0, 4), 'RIFF', 'volc: wav RIFF magic');
  eq(wav.toString('ascii', 8, 12), 'WAVE', 'volc: wav WAVE magic');
  eq(wav.readUInt32LE(24), 16000, 'volc: wav sample rate 16k');
  eq(
    wav.subarray(44).every((b) => b === 0),
    true,
    'volc: wav data all zero (silence)',
  );
}

// --- volcengineUtils: extractVolcResult（毫秒→秒、words 拍平、utterance→segment） ---
eq(
  extractVolcResult({
    result: {
      text: '你好，世界。',
      utterances: [
        {
          text: '你好，世界。',
          start_time: 1000,
          end_time: 2500,
          words: [
            { text: '你好', start_time: 1000, end_time: 1600 },
            { text: '世界', start_time: 1800, end_time: 2500 },
            { text: '', start_time: 2500, end_time: 2500 },
            { text: 'x', start_time: 'oops', end_time: 2600 },
          ],
        },
      ],
    },
  }),
  {
    text: '你好，世界。',
    words: [
      { word: '你好', start: 1, end: 1.6 },
      { word: '世界', start: 1.8, end: 2.5 },
    ],
    segments: [{ start: 1, end: 2.5, text: '你好，世界。' }],
  },
  'volc: ms->s, flattens words, drops empty/non-finite, keeps utterance segment',
);
eq(
  extractVolcResult({
    result: {
      text: 'Hello world.',
      utterances: [{ text: 'Hello world.', start_time: 0, end_time: 900 }],
    },
  }),
  {
    text: 'Hello world.',
    words: [],
    segments: [{ start: 0, end: 0.9, text: 'Hello world.' }],
  },
  'volc: utterances without words -> segment-level fallback only',
);
eq(
  extractVolcResult({}),
  { text: '', words: [], segments: [] },
  'volc: empty response -> safe defaults',
);

// ===========================================================================
// 腾讯极速版：请求参数 / 字典序查询串 / 签名 v1 / voice_format / 结果提取 / code 分类
// ===========================================================================

// --- tencentUtils: 常量（签名原文绑定 Host，端点不开放自定义） ---
eq(TENCENT_ASR_HOST, 'asr.cloud.tencent.com', 'tencent: fixed host');
eq(
  TENCENT_FLASH_PATH,
  '/asr/flash/v1/',
  'tencent: flash path with trailing slash',
);

// --- tencentUtils: buildTencentParams（固定参数集，URL 安全值） ---
const tencentParams = buildTencentParams({
  secretId: 'AKIDtest',
  engineType: '16k_zh',
  voiceFormat: 'wav',
  timestamp: 1700000000,
});
eq(
  tencentParams,
  {
    secretid: 'AKIDtest',
    engine_type: '16k_zh',
    voice_format: 'wav',
    timestamp: '1700000000',
    word_info: '1',
    filter_punc: '0',
    convert_num_mode: '1',
    first_channel_only: '1',
    speaker_diarization: '0',
  },
  'tencent: fixed param set (word_info=1, punct kept, mono, no diarization)',
);
eq(
  Object.values(tencentParams).every((v) => /^[A-Za-z0-9_-]+$/.test(v)),
  true,
  'tencent: all param values URL-safe (no encoding ambiguity in signature)',
);

// --- tencentUtils: buildTencentQuery（key 字典序，排序串即最终 URL 查询串） ---
const tencentQuery = buildTencentQuery(tencentParams);
eq(
  tencentQuery,
  'convert_num_mode=1&engine_type=16k_zh&filter_punc=0&first_channel_only=1&secretid=AKIDtest&speaker_diarization=0&timestamp=1700000000&voice_format=wav&word_info=1',
  'tencent: query sorted lexicographically by key',
);
eq(
  buildTencentQuery({ b: '2', a: '1', c: '3' }),
  'a=1&b=2&c=3',
  'tencent: generic dict-order join',
);

// --- tencentUtils: signTencentRequest（HMAC-SHA1-base64 固定向量，独立预计算） ---
// 向量生成：POST + asr.cloud.tencent.com/asr/flash/v1/1300000000?{上面 query}，
// HMAC-SHA1(key='TestSecretKey') → base64（node:crypto 独立算出，防实现回归）。
eq(
  signTencentRequest('TestSecretKey', '1300000000', tencentQuery),
  'a38vmBf1ujfiJ+tNg9z2viHpnns=',
  'tencent: signature v1 matches precomputed HMAC-SHA1 vector',
);
eq(
  signTencentRequest('AnotherKey', '1300000000', tencentQuery) !==
    signTencentRequest('TestSecretKey', '1300000000', tencentQuery),
  true,
  'tencent: signature varies with secretKey',
);

// --- tencentUtils: resolveTencentEngineType（档位 + 原语言 → engine_type） ---
eq(
  resolveTencentEngineType('standard', 'zh'),
  '16k_zh',
  'tencent: standard + zh -> 16k_zh',
);
eq(
  resolveTencentEngineType('standard', 'en'),
  '16k_en',
  'tencent: standard + en -> 16k_en',
);
eq(
  resolveTencentEngineType('standard', 'ja'),
  '16k_ja',
  'tencent: standard + ja -> 16k_ja',
);
eq(
  resolveTencentEngineType('standard', 'yue'),
  '16k_yue',
  'tencent: standard + yue -> 16k_yue',
);
eq(
  resolveTencentEngineType('standard', 'zh-Hant'),
  '16k_zh',
  'tencent: zh-Hant treated as Mandarin speech',
);
eq(
  resolveTencentEngineType('large', 'zh'),
  '16k_zh_en',
  'tencent: large + zh -> 16k_zh_en (LLM tier)',
);
eq(
  resolveTencentEngineType('large', 'en'),
  '16k_zh_en',
  'tencent: large + en -> 16k_zh_en (covers zh/en/yue)',
);
eq(
  resolveTencentEngineType('large', 'ja'),
  '16k_multi_lang',
  'tencent: large + ja -> 16k_multi_lang (15 languages, no zh)',
);
eq(
  resolveTencentEngineType('standard', 'auto'),
  '16k_zh-PY',
  'tencent: standard + auto -> 16k_zh-PY mixed zh/en/yue',
);
eq(
  resolveTencentEngineType('standard', undefined),
  '16k_zh-PY',
  'tencent: missing language treated as auto',
);
eq(
  resolveTencentEngineType('large', 'auto'),
  '16k_zh_en',
  'tencent: large + auto -> 16k_zh_en',
);
eq(
  resolveTencentEngineType('', 'zh'),
  '16k_zh',
  'tencent: empty tier falls back to standard',
);
eq(
  resolveTencentEngineType('16k_yue', 'en'),
  '16k_yue',
  'tencent: raw engine_type passes through, language ignored (legacy)',
);
eq(
  resolveTencentEngineType('standard', 'ru'),
  null,
  'tencent: unsupported language -> null (caller errors before upload)',
);
eq(
  resolveTencentEngineType('large', 'it'),
  null,
  'tencent: unsupported language on large tier -> null',
);

// --- tencentUtils: voiceFormatFromPath（引擎产物仅 wav/mp3；其余透传/回落） ---
eq(voiceFormatFromPath('/tmp/a.wav'), 'wav', 'tencent: .wav -> wav');
eq(
  voiceFormatFromPath('/tmp/b.MP3'),
  'mp3',
  'tencent: .MP3 -> mp3 (case-insensitive)',
);
eq(voiceFormatFromPath('/tmp/c.ogg'), 'ogg-opus', 'tencent: .ogg -> ogg-opus');
eq(
  voiceFormatFromPath('/tmp/noext'),
  'wav',
  'tencent: no extension -> wav fallback',
);
eq(voiceFormatFromPath(''), 'wav', 'tencent: empty path -> wav fallback');

// --- tencentUtils: extractTencentResult（文档样例形态：毫秒→秒、words 拍平、text 带标点） ---
eq(
  extractTencentResult({
    code: 0,
    message: 'success',
    audio_duration: 2500,
    flash_result: [
      {
        text: '你好，世界。',
        sentence_list: [
          {
            text: '你好，世界。',
            start_time: 1000,
            end_time: 2500,
            word_list: [
              { word: '你好', start_time: 1000, end_time: 1600 },
              { word: '世界', start_time: 1800, end_time: 2500 },
              { word: '', start_time: 2500, end_time: 2500 },
              { word: 'x', start_time: 'oops', end_time: 2600 },
            ],
          },
        ],
      },
    ],
  }),
  {
    text: '你好，世界。',
    words: [
      { word: '你好', start: 1, end: 1.6 },
      { word: '世界', start: 1.8, end: 2.5 },
    ],
    segments: [{ start: 1, end: 2.5, text: '你好，世界。' }],
  },
  'tencent: ms->s, flattens word_list, drops empty/non-finite, keeps punctuated text',
);
eq(
  extractTencentResult({
    code: 0,
    flash_result: [
      {
        text: 'Hello world.',
        sentence_list: [{ text: 'Hello world.', start_time: 0, end_time: 900 }],
      },
    ],
  }),
  {
    text: 'Hello world.',
    words: [],
    segments: [{ start: 0, end: 0.9, text: 'Hello world.' }],
  },
  'tencent: sentence_list without word_list -> segment-level fallback only',
);
eq(
  extractTencentResult({ code: 0, flash_result: [] }),
  { text: '', words: [], segments: [] },
  'tencent: empty flash_result -> safe defaults',
);
eq(
  extractTencentResult({}),
  { text: '', words: [], segments: [] },
  'tencent: empty response -> safe defaults',
);

// --- tencentUtils: classifyTencentCode（code 优先于 HTTP；未知码不重试） ---
eq(classifyTencentCode(200, 0), 'success', 'tencent: code 0 success');
eq(classifyTencentCode(200, '0'), 'success', 'tencent: string code 0 success');
eq(classifyTencentCode(200, 4002), 'auth', 'tencent: 4002 auth failure');
eq(
  classifyTencentCode(200, 4003),
  'fatal',
  'tencent: 4003 service not activated -> fatal',
);
eq(classifyTencentCode(200, 4005), 'fatal', 'tencent: 4005 arrears -> fatal');
eq(
  classifyTencentCode(200, 4006),
  'retriable',
  'tencent: 4006 concurrency -> retriable',
);
eq(
  classifyTencentCode(200, 4008),
  'retriable',
  'tencent: 4008 queue timeout -> retriable',
);
eq(
  classifyTencentCode(200, 5001),
  'retriable',
  'tencent: 5001 server error -> retriable',
);
eq(
  classifyTencentCode(200, 5003),
  'retriable',
  'tencent: 5003 server error -> retriable',
);
eq(
  classifyTencentCode(200, 4001),
  'fatal',
  'tencent: 4001 param error -> fatal',
);
eq(
  classifyTencentCode(200, 4011),
  'fatal',
  'tencent: 4011 audio too large -> fatal',
);
eq(
  classifyTencentCode(200, 9999),
  'fatal',
  'tencent: unknown code -> fatal (no silent retry)',
);
eq(
  classifyTencentCode(503, null),
  'retriable',
  'tencent: HTTP 5xx without code -> retriable',
);
eq(
  classifyTencentCode(429, null),
  'retriable',
  'tencent: HTTP 429 without code -> retriable',
);
eq(
  classifyTencentCode(404, null),
  'fatal',
  'tencent: HTTP 404 without code -> fatal',
);
eq(
  classifyTencentCode(200, null),
  'fatal',
  'tencent: no code + HTTP 200 -> fatal (unparseable)',
);

// ===========================================================================
// 阿里云极速版：POP 签名 / RFC3986 编码 / Token 过期 / Flash 查询串 / 结果提取 / status 分类
// ===========================================================================

// --- aliyunUtils: 常量（识别与取号端点固定，不开放自定义） ---
eq(
  ALIYUN_NLS_GATEWAY_HOST,
  'nls-gateway-cn-shanghai.aliyuncs.com',
  'aliyun: fixed gateway host',
);
eq(ALIYUN_FLASH_PATH, '/stream/v1/FlashRecognizer', 'aliyun: flash path');
eq(
  ALIYUN_META_HOST,
  'nls-meta.cn-shanghai.aliyuncs.com',
  'aliyun: fixed meta (CreateToken) host',
);

// --- aliyunUtils: percentEncodeRfc3986（POP 签名编码口径，错一个字符即 401） ---
eq(percentEncodeRfc3986('a b'), 'a%20b', 'aliyun: space -> %20 (not +)');
eq(percentEncodeRfc3986('*'), '%2A', 'aliyun: * -> %2A');
eq(
  percentEncodeRfc3986('~'),
  '~',
  'aliyun: ~ stays unencoded (RFC3986 unreserved)',
);
eq(percentEncodeRfc3986("!'()"), '%21%27%28%29', "aliyun: !'() all encoded");
eq(percentEncodeRfc3986('-_.'), '-_.', 'aliyun: -_. stay unencoded');
eq(
  percentEncodeRfc3986('2026-07-02T00:00:00Z'),
  '2026-07-02T00%3A00%3A00Z',
  'aliyun: ISO8601 colon encoded',
);

// --- aliyunUtils: buildCreateTokenQuery（9 公共参数、key 字典序、逐 k/v 编码） ---
const aliyunTokenQuery = buildCreateTokenQuery(
  'LTAItest',
  'nonce-1234',
  '2026-07-02T00:00:00Z',
);
eq(
  aliyunTokenQuery,
  'AccessKeyId=LTAItest&Action=CreateToken&Format=JSON&RegionId=cn-shanghai&SignatureMethod=HMAC-SHA1&SignatureNonce=nonce-1234&SignatureVersion=1.0&Timestamp=2026-07-02T00%3A00%3A00Z&Version=2019-02-28',
  'aliyun: CreateToken query sorted + percent-encoded (9 params)',
);

// --- aliyunUtils: signCreateToken（HMAC-SHA1-base64 固定向量，独立预计算） ---
// 向量生成：原文 GET&%2F&percentEncode(上面 query)，HMAC-SHA1(key='TestSecret&') → base64
// （node:crypto 独立算出，防实现回归）。
eq(
  signCreateToken('TestSecret', aliyunTokenQuery),
  'epSSDRaAbN3SlUcKjiHPrS1ke6g=',
  'aliyun: POP signature matches precomputed HMAC-SHA1 vector',
);
eq(
  signCreateToken('OtherSecret', aliyunTokenQuery) !==
    signCreateToken('TestSecret', aliyunTokenQuery),
  true,
  'aliyun: signature varies with accessKeySecret',
);

// --- aliyunUtils: isTokenExpired（ExpireTime 秒级绝对时间戳，提前 5 分钟余量） ---
{
  const nowMs = 1_783_000_000_000; // 任意固定“当前时刻”
  const nowSec = nowMs / 1000;
  eq(
    isTokenExpired(nowSec + 3600, nowMs),
    false,
    'aliyun: token valid 1h before expiry',
  );
  eq(
    isTokenExpired(nowSec + 200, nowMs),
    true,
    'aliyun: token within 5min margin -> treated expired (proactive refresh)',
  );
  eq(isTokenExpired(nowSec - 1, nowMs), true, 'aliyun: token past expiry');
  eq(isTokenExpired(NaN, nowMs), true, 'aliyun: invalid expireTime -> expired');
  eq(isTokenExpired(0, nowMs), true, 'aliyun: zero expireTime -> expired');
  eq(
    isTokenExpired(nowSec + 200, nowMs, 0),
    false,
    'aliyun: margin 0 -> only actual expiry counts',
  );
}

// --- aliyunUtils: buildFlashQuery（固定参数集：词级开、ITN 关、首声道） ---
eq(
  buildFlashQuery({ appkey: 'a3Hwxxxx', token: 'tok123', format: 'mp3' }),
  'appkey=a3Hwxxxx&token=tok123&format=mp3&sample_rate=16000&enable_word_level_result=true&enable_inverse_text_normalization=false&first_channel_only=true',
  'aliyun: flash query fixed param set',
);

// --- aliyunUtils: extractAliyunResult（实测形态：words 字符串毫秒、punc 拼接、trim 尾空格） ---
// 中文样本实测形态（官方 nls-sample-16k.wav）：words 时间戳为字符串毫秒、punc 全角无空格。
eq(
  extractAliyunResult({
    task_id: 'x',
    status: 20000000,
    flash_result: {
      duration: 3101,
      sentences: [
        {
          text: '北京的天气。',
          begin_time: 880,
          end_time: 3080,
          channel_id: 0,
          words: [
            { text: '北京', begin_time: '880', end_time: '1760', punc: '' },
            { text: '的', begin_time: '1760', end_time: '2200', punc: '' },
            { text: '天气', begin_time: '2200', end_time: '3080', punc: '。' },
          ],
        },
      ],
    },
  }),
  {
    text: '北京的天气。',
    words: [
      { word: '北京', start: 0.88, end: 1.76 },
      { word: '的', start: 1.76, end: 2.2 },
      { word: '天气。', start: 2.2, end: 3.08 },
    ],
    segments: [{ start: 0.88, end: 3.08, text: '北京的天气。' }],
  },
  'aliyun: string-ms words -> sec, punc appended to word text',
);
// 英文样本实测形态：词 text 自带尾空格（"welcome "）、punc 亦带尾空格（". "）——必须 trim，
// 否则与下游拉丁词补前置空格逻辑叠出双空格；多句 text 以空格拼接（needsSpaceBefore）。
eq(
  extractAliyunResult({
    status: 20000000,
    flash_result: {
      sentences: [
        {
          text: 'hello, ',
          begin_time: 0,
          end_time: 425,
          words: [
            { text: 'hello', begin_time: '0', end_time: '425', punc: ', ' },
          ],
        },
        {
          text: 'welcome to master. ',
          begin_time: 1063,
          end_time: 3402,
          words: [
            {
              text: 'welcome ',
              begin_time: '1063',
              end_time: '1488',
              punc: '',
            },
            { text: 'to ', begin_time: '1488', end_time: '1701', punc: '' },
            {
              text: 'master',
              begin_time: '2977',
              end_time: '3402',
              punc: '. ',
            },
          ],
        },
      ],
    },
  }),
  {
    text: 'hello, welcome to master.',
    words: [
      { word: 'hello,', start: 0, end: 0.425 },
      { word: 'welcome', start: 1.063, end: 1.488 },
      { word: 'to', start: 1.488, end: 1.701 },
      { word: 'master.', start: 2.977, end: 3.402 },
    ],
    segments: [
      { start: 0, end: 0.425, text: 'hello,' },
      { start: 1.063, end: 3.402, text: 'welcome to master.' },
    ],
  },
  'aliyun: trailing spaces trimmed (text+punc), latin sentences joined with space',
);
eq(
  extractAliyunResult({
    status: 20000000,
    flash_result: {
      sentences: [{ text: '你好。', begin_time: 0, end_time: 900 }],
    },
  }),
  {
    text: '你好。',
    words: [],
    segments: [{ start: 0, end: 0.9, text: '你好。' }],
  },
  'aliyun: sentences without words -> segment-level fallback only',
);
eq(
  extractAliyunResult({}),
  { text: '', words: [], segments: [] },
  'aliyun: empty response -> safe defaults',
);

// --- aliyunUtils: classifyAliyunStatus（status 优先于 HTTP；40270002 单列 empty） ---
eq(classifyAliyunStatus(200, 20000000), 'success', 'aliyun: 20000000 success');
eq(
  classifyAliyunStatus(200, '20000000'),
  'success',
  'aliyun: string status success',
);
eq(
  classifyAliyunStatus(400, 40270002),
  'empty',
  'aliyun: 40270002 vad silent -> empty (probe passes, task returns empty)',
);
eq(
  classifyAliyunStatus(200, 40000001),
  'auth',
  'aliyun: 40000001 token expired -> auth (force refresh + retry once)',
);
eq(classifyAliyunStatus(403, null), 'auth', 'aliyun: HTTP 403 -> auth');
eq(classifyAliyunStatus(200, 403), 'auth', 'aliyun: status 403 -> auth');
eq(
  classifyAliyunStatus(200, 40000004),
  'retriable',
  'aliyun: 40000004 idle timeout -> retriable (official guidance)',
);
eq(
  classifyAliyunStatus(200, 40000005),
  'retriable',
  'aliyun: 40000005 concurrency -> retriable',
);
eq(
  classifyAliyunStatus(500, 50000000),
  'retriable',
  'aliyun: 50000000 -> retriable',
);
eq(
  classifyAliyunStatus(500, 52010001),
  'retriable',
  'aliyun: 52010001 -> retriable',
);
eq(
  classifyAliyunStatus(400, 40000010),
  'fatal',
  'aliyun: 40000010 trial expired / not activated -> fatal',
);
eq(
  classifyAliyunStatus(400, 40020105),
  'fatal',
  'aliyun: 40020105 appkey not exist -> fatal',
);
eq(
  classifyAliyunStatus(400, 40020106),
  'fatal',
  'aliyun: 40020106 appkey mismatch -> fatal',
);
eq(
  classifyAliyunStatus(400, 40270001),
  'fatal',
  'aliyun: unsupported format -> fatal',
);
eq(
  classifyAliyunStatus(200, 99999999),
  'fatal',
  'aliyun: unknown status -> fatal (no silent retry)',
);
eq(
  classifyAliyunStatus(503, null),
  'retriable',
  'aliyun: HTTP 5xx without status -> retriable',
);
eq(
  classifyAliyunStatus(429, null),
  'retriable',
  'aliyun: HTTP 429 without status -> retriable',
);
eq(
  classifyAliyunStatus(400, null),
  'fatal',
  'aliyun: HTTP 400 without status -> fatal',
);

// --- xfyunUtils: 常量（签名原文绑定 Host，端点不开放自定义） ---
eq(XFYUN_API_HOST, 'office-api-ist-dx.iflyaisol.com', 'xfyun: host constant');
eq(XFYUN_UPLOAD_PATH, '/v2/upload', 'xfyun: upload path');
eq(XFYUN_GET_RESULT_PATH, '/v2/getResult', 'xfyun: getResult path');

// --- xfyunUtils: normalizeXfyunTier（仅 autominor 识别为多语种档，其余回落默认） ---
eq(normalizeXfyunTier('autodialect'), 'autodialect', 'xfyun tier: autodialect');
eq(normalizeXfyunTier('autominor'), 'autominor', 'xfyun tier: autominor');
eq(
  normalizeXfyunTier(' AutoMinor '),
  'autominor',
  'xfyun tier: trims + case-insensitive',
);
eq(
  normalizeXfyunTier(undefined),
  'autodialect',
  'xfyun tier: undefined -> default',
);
eq(normalizeXfyunTier(''), 'autodialect', 'xfyun tier: empty -> default');
eq(
  normalizeXfyunTier('bogus'),
  'autodialect',
  'xfyun tier: unknown -> default',
);

// --- xfyunUtils: resolveXfyunLanguageSupport（档位 × 原语言上传前守卫） ---
eq(
  resolveXfyunLanguageSupport('autodialect', 'auto'),
  'ok',
  'xfyun guard: dialect + auto ok (tier itself is auto-detect)',
);
eq(
  resolveXfyunLanguageSupport('autodialect', undefined),
  'ok',
  'xfyun guard: dialect + missing language -> auto ok',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'zh'),
  'ok',
  'xfyun guard: dialect + zh ok',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'yue'),
  'ok',
  'xfyun guard: dialect + Cantonese ok (in 202 dialects)',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'en'),
  'ok',
  'xfyun guard: dialect + en ok',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'ja'),
  'switch-tier',
  'xfyun guard: dialect + ja -> suggest autominor',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'ko'),
  'switch-tier',
  'xfyun guard: dialect + ko -> suggest autominor',
);
eq(
  resolveXfyunLanguageSupport('autominor', 'ja'),
  'ok',
  'xfyun guard: minor + ja ok',
);
eq(
  resolveXfyunLanguageSupport('autominor', 'bo'),
  'ok',
  'xfyun guard: minor + Tibetan ok (37-language list)',
);
eq(
  resolveXfyunLanguageSupport('autominor', 'yue'),
  'switch-tier',
  'xfyun guard: minor + Cantonese -> suggest autodialect',
);
eq(
  resolveXfyunLanguageSupport('autodialect', 'am'),
  'unsupported',
  'xfyun guard: Amharic unsupported by both tiers',
);
eq(
  resolveXfyunLanguageSupport('autominor', 'am'),
  'unsupported',
  'xfyun guard: minor + Amharic unsupported',
);
eq(
  resolveXfyunLanguageSupport(undefined, 'ZH'),
  'ok',
  'xfyun guard: default tier + uppercase language normalized',
);

// --- xfyunUtils: buildXfyunDateTime（本地时区 yyyy-MM-ddTHH:mm:ss±HHmm） ---
eq(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(buildXfyunDateTime()),
  true,
  'xfyun dateTime: shape yyyy-MM-ddTHH:mm:ss±HHmm',
);
{
  const d = new Date(2026, 6, 2, 22, 30, 32); // 本地时区 2026-07-02 22:30:32
  const s = buildXfyunDateTime(d);
  eq(s.startsWith('2026-07-02T22:30:32'), true, 'xfyun dateTime: local fields');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  eq(
    s.slice(19),
    `${sign}${hh}${mm}`,
    'xfyun dateTime: tz suffix matches host tz',
  );
}

// --- xfyunUtils: buildXfyunRandom（16 位字母数字，逐次不同） ---
eq(buildXfyunRandom().length, 16, 'xfyun random: default 16 chars');
eq(
  /^[A-Za-z0-9]{16}$/.test(buildXfyunRandom()),
  true,
  'xfyun random: alphanumeric only',
);
eq(
  buildXfyunRandom() === buildXfyunRandom(),
  false,
  'xfyun random: two draws differ',
);

// --- xfyunUtils: javaUrlEncode（Java URLEncoder 兼容：空格→+，!'()~ 转义） ---
eq(javaUrlEncode('abc123.-*_'), 'abc123.-*_', 'xfyun encode: safe chars kept');
eq(javaUrlEncode('a b'), 'a+b', 'xfyun encode: space -> +');
eq(
  javaUrlEncode("!'()~"),
  '%21%27%28%29%7E',
  'xfyun encode: java extras escaped',
);
eq(
  javaUrlEncode('2026-07-02T22:30:32+0800'),
  '2026-07-02T22%3A30%3A32%2B0800',
  'xfyun encode: dateTime colon/plus escaped',
);
eq(javaUrlEncode('音频'), '%E9%9F%B3%E9%A2%91', 'xfyun encode: utf-8 percent');

// --- xfyunUtils: buildXfyunQuery（过滤空值、按名 ASCII 排序、排序串即请求串） ---
eq(
  buildXfyunQuery({ b: '2', a: '1', c: undefined, d: '' }),
  'a=1&b=2',
  'xfyun query: sorts keys and drops empty values',
);
eq(
  buildXfyunQuery({
    signatureRandom: '0123456789abcdef',
    appId: 'abc',
    dateTime: '2026-07-02T10:00:00+0800',
  }),
  'appId=abc&dateTime=2026-07-02T10%3A00%3A00%2B0800&signatureRandom=0123456789abcdef',
  'xfyun query: values java-url-encoded, ASCII key order',
);

// --- xfyunUtils: signXfyunRequest（HMAC-SHA1-base64 固定向量，独立预计算） ---
eq(
  signXfyunRequest(
    'testsecret',
    'appId=abc&dateTime=2026-07-02T10%3A00%3A00%2B0800&signatureRandom=0123456789abcdef',
  ),
  'TB+lxwHUWgBejbtkyD3TE6qyzxI=',
  'xfyun sign: hmac-sha1 base64 fixed vector',
);

// --- xfyunUtils: xfyunFileNameFromPath（audio.<真实扩展名>，未知回落 wav） ---
eq(
  xfyunFileNameFromPath('/tmp/a b/视频.MP3'),
  'audio.mp3',
  'xfyun name: keeps ext, lowercased',
);
eq(xfyunFileNameFromPath('/tmp/x.wav'), 'audio.wav', 'xfyun name: wav');
eq(
  xfyunFileNameFromPath('/tmp/noext'),
  'audio.wav',
  'xfyun name: no ext -> wav',
);
eq(xfyunFileNameFromPath(''), 'audio.wav', 'xfyun name: empty -> wav');

// --- xfyunUtils: classifyXfyunCode（code 优先于 HTTP；鉴权码不重试） ---
eq(classifyXfyunCode(200, '000000'), 'success', 'xfyun code: 000000 success');
eq(
  classifyXfyunCode(200, '000002'),
  'auth',
  'xfyun code: 000002 bad APIKey -> auth',
);
eq(
  classifyXfyunCode(200, '100009'),
  'auth',
  'xfyun code: 100009 bad signature -> auth',
);
eq(
  classifyXfyunCode(200, '100008'),
  'auth',
  'xfyun code: 100008 clock skew -> auth',
);
eq(
  classifyXfyunCode(200, '100007'),
  'auth',
  'xfyun code: 100007 permission -> auth',
);
eq(
  classifyXfyunCode(200, '100012'),
  'retriable',
  'xfyun code: 100012 rate limit -> retriable',
);
eq(
  classifyXfyunCode(200, '999999'),
  'retriable',
  'xfyun code: 999999 unknown -> retriable',
);
eq(
  classifyXfyunCode(200, '100003'),
  'fatal',
  'xfyun code: param error -> fatal',
);
eq(
  classifyXfyunCode(429, null),
  'retriable',
  'xfyun code: HTTP 429 no code -> retriable',
);
eq(
  classifyXfyunCode(503, undefined),
  'retriable',
  'xfyun code: HTTP 5xx no code -> retriable',
);
eq(
  classifyXfyunCode(400, null),
  'fatal',
  'xfyun code: HTTP 400 no code -> fatal',
);

// --- xfyunUtils: isXfyunOrderGone（订单不存在/非法 → 续查回落新上传） ---
eq(isXfyunOrderGone('100037'), true, 'xfyun gone: 100037 orderId illegal');
eq(isXfyunOrderGone('100001'), true, 'xfyun gone: 100001');
eq(isXfyunOrderGone('100039'), true, 'xfyun gone: 100039');
eq(
  isXfyunOrderGone('100013'),
  false,
  'xfyun gone: 100013 in-progress is not gone',
);
eq(isXfyunOrderGone('000000'), false, 'xfyun gone: success is not gone');
eq(isXfyunOrderGone(undefined), false, 'xfyun gone: missing code');

// --- xfyunUtils: mapXfyunFailType（可行动文案；0/非数字无异常；6 静音由调用方处理） ---
eq(mapXfyunFailType(0), null, 'xfyun fail: 0 -> no error');
eq(mapXfyunFailType(undefined), null, 'xfyun fail: undefined -> no error');
eq(
  /5-hour/.test(String(mapXfyunFailType(4))),
  true,
  'xfyun fail: 4 -> duration limit message',
);
eq(
  /failType 99/.test(String(mapXfyunFailType(99))),
  true,
  'xfyun fail: unknown type keeps code in message',
);

// --- xfyunUtils: extractXfyunResult（实测形态：json_1best 为字符串，标点内联，wb/we 帧换算） ---
{
  const orderResult = JSON.stringify({
    lattice: [
      {
        json_1best: JSON.stringify({
          st: {
            bg: '1000',
            ed: '3500',
            rt: [
              {
                ws: [
                  { cw: [{ w: '大家', wp: 'n' }], wb: 10, we: 40 },
                  { cw: [{ w: '好', wp: 'n' }], wb: 41, we: 60 },
                  { cw: [{ w: '，', wp: 'p' }], wb: 0, we: 0 },
                  { cw: [{ w: '嗯', wp: 's' }], wb: 61, we: 70 },
                  { cw: [{ w: 'hello', wp: 'n' }], wb: 71, we: 100 },
                ],
              },
            ],
          },
        }),
      },
      {
        json_1best: JSON.stringify({
          st: {
            bg: '4000',
            ed: '5000',
            rt: [
              {
                ws: [
                  { cw: [{ w: 'world', wp: 'n' }], wb: 5, we: 30 },
                  { cw: [{ w: '。', wp: 'p' }], wb: 0, we: 0 },
                ],
              },
            ],
          },
        }),
      },
    ],
  });
  eq(
    extractXfyunResult(orderResult),
    {
      text: '大家好，hello world。',
      words: [
        { word: '大家', start: 1.1, end: 1.4 },
        { word: '好，', start: 1.41, end: 1.6 },
        { word: 'hello', start: 1.71, end: 2.0 },
        { word: 'world。', start: 4.05, end: 4.3 },
      ],
      segments: [
        { start: 1, end: 3.5, text: '大家好，hello' },
        { start: 4, end: 5, text: 'world。' },
      ],
    },
    'xfyun extract: punctuation inlined, smooth words dropped, frame math (bg+wb*10)/1000',
  );
}
{
  // 文档示例形态：json_1best 已是对象（非字符串）。
  const orderResult = {
    lattice: [
      {
        json_1best: {
          st: {
            bg: '0',
            ed: '2000',
            rt: [
              {
                ws: [{ cw: [{ w: 'Hi', wp: 'n' }], wb: 1, we: 20 }],
              },
            ],
          },
        },
      },
    ],
  };
  eq(
    extractXfyunResult(orderResult),
    {
      text: 'Hi',
      words: [{ word: 'Hi', start: 0.01, end: 0.2 }],
      segments: [{ start: 0, end: 2, text: 'Hi' }],
    },
    'xfyun extract: json_1best as object (doc sample shape)',
  );
}
eq(
  extractXfyunResult('not json'),
  { text: '', words: [], segments: [] },
  'xfyun extract: invalid json -> safe empty',
);
eq(
  extractXfyunResult(JSON.stringify({ lattice: [{ json_1best: 'broken' }] })),
  { text: '', words: [], segments: [] },
  'xfyun extract: broken element skipped -> empty',
);
eq(
  extractXfyunResult(undefined),
  { text: '', words: [], segments: [] },
  'xfyun extract: undefined -> safe empty',
);

console.log(`\nengine unit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
