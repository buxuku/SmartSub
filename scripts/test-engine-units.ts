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
  retimeTokensToSpeech,
  groupTokenCues,
  clampCuesToSegments,
  clampCuesToDominantSegments,
  mergeShortCues,
  dropCuesInDeepSilence,
  enforceMinDisplayDuration,
  type TokenTriple,
} from '../main/helpers/subtitleSegmentation';

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

// --- subtitleSegmentation: retimeTokensToSpeech（用语音段把 token 贴回有声区间） ---
const T = (a: string, b: string, c: string): TokenTriple => [a, b, c];
{
  const tokens = [
    T('00:00:00.000', '00:00:02.000', '你好'),
    T('00:00:02.000', '00:00:13.000', '世界'),
  ];
  // 空边界（边界源不可用）→ 原样返回，优雅降级
  eq(
    retimeTokensToSpeech(tokens, []),
    tokens,
    'retime: empty segments returns tokens unchanged',
  );
  // 有边界 → 被「填满」的第二个 token 收敛回真实有声 [12,13]，段间停顿重现
  eq(
    retimeTokensToSpeech(tokens, [
      { start: 0, end: 2 },
      { start: 12, end: 14 },
    ]),
    [
      ['00:00:00,000', '00:00:02,000', '你好'],
      ['00:00:12,000', '00:00:13,000', '世界'],
    ],
    'retime: filled token snapped back to its speech segment (gap restored)',
  );
  // 浮动内容 run 离「后段」更近 → 整 run 前向平移到后段起点（whisper 前向填充的反向修正）
  eq(
    retimeTokensToSpeech(
      [T('00:00:09,500', '00:00:09,800', 'x')],
      [
        { start: 0, end: 2 },
        { start: 10, end: 12 },
      ],
    ),
    [['00:00:10,000', '00:00:10,300', 'x']],
    'retime: floating run nearer to next segment snaps forward to its start',
  );
  // 浮动内容 run 离「前段」更近 → 整 run 后向平移紧接前段末点（不再被错误前向抛远）
  eq(
    retimeTokensToSpeech(
      [T('00:00:05,200', '00:00:05,500', 'x')],
      [
        { start: 0, end: 5 },
        { start: 10, end: 12 },
      ],
    ),
    [['00:00:05,000', '00:00:05,300', 'x']],
    'retime: floating run nearer to prev segment snaps back to abut its end',
  );
  // 句尾尾字越过 VAD 末点（…應用十分廣|泛）→ 「泛」回贴到上一句末点附近，绝不被抛到下一句
  // 廣[49.85,50.09] 与前段[44.96,49.916]有交集 → anchored 截到 [49.85,49.916]
  // 泛[50.09,50.40] 落静音、离前段更近 → 后向平移 delta=-0.174 → [49.916,50.226]
  // 。[50.40,50.40] 零时长纯标点、不在段内 → 原样保留
  eq(
    retimeTokensToSpeech(
      [
        T('00:00:49,850', '00:00:50,090', '廣'),
        T('00:00:50,090', '00:00:50,400', '泛'),
        T('00:00:50,400', '00:00:50,400', '。'),
      ],
      [
        { start: 44.96, end: 49.916 },
        { start: 53.862, end: 56.76 },
      ],
    ),
    [
      ['00:00:49,850', '00:00:49,916', '廣'],
      ['00:00:49,916', '00:00:50,226', '泛'],
      ['00:00:50,400', '00:00:50,400', '。'],
    ],
    'retime: trailing tail token stays beside prev sentence (not flung to next)',
  );
  // 多 token run 前向平移保留内部相对偏移与顺序
  eq(
    retimeTokensToSpeech(
      [
        T('00:00:08,000', '00:00:08,300', '甲'),
        T('00:00:08,300', '00:00:08,700', '乙'),
      ],
      [
        { start: 0, end: 2 },
        { start: 10, end: 14 },
      ],
    ),
    [
      ['00:00:10,000', '00:00:10,300', '甲'],
      ['00:00:10,300', '00:00:10,700', '乙'],
    ],
    'retime: multi-token floating run preserves internal offsets when snapped',
  );
  // 零时长内容 run 落在静音、离后段更近 → 平移到后段起点（随后段首 token 合并，消除零时长孤条）
  eq(
    retimeTokensToSpeech(
      [
        T('00:00:09,000', '00:00:09,000', '人'),
        T('00:00:09,000', '00:00:09,000', '工'),
      ],
      [
        { start: 0, end: 2 },
        { start: 10, end: 12 },
      ],
    ),
    [
      ['00:00:10,000', '00:00:10,000', '人'],
      ['00:00:10,000', '00:00:10,000', '工'],
    ],
    'retime: zero-duration content run in silence snapped to next segment start',
  );
  // 零时长内容 token 落在「段内」→ 按点判定为 anchored，原样保留（绝不被误判浮动抛走）
  eq(
    retimeTokensToSpeech(
      [T('00:00:03,000', '00:00:03,000', '技')],
      [{ start: 0, end: 5 }],
    ),
    [['00:00:03,000', '00:00:03,000', '技']],
    'retime: zero-duration content token inside a segment kept anchored in place',
  );
  // 落在静音的「空 / 空白 token」→ 原样保留（护栏，避免噪声错位）
  eq(
    retimeTokensToSpeech(
      [T('00:00:05,000', '00:00:06,000', ' ')],
      [
        { start: 0, end: 2 },
        { start: 12, end: 14 },
      ],
    ),
    [['00:00:05,000', '00:00:06,000', ' ']],
    'retime: empty/space token in silence kept as-is (guard)',
  );
  // 落在静音的「纯标点 token」→ 原样保留（随相邻 cue 收尾，不前向贴齐成孤立标点条）
  eq(
    retimeTokensToSpeech(
      [T('00:00:05,000', '00:00:05,100', '。')],
      [
        { start: 0, end: 2 },
        { start: 12, end: 14 },
      ],
    ),
    [['00:00:05,000', '00:00:05,100', '。']],
    'retime: punct-only token in silence kept as-is',
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

// --- subtitleSegmentation: retime+group 端到端（D8：被填进静音的内容 token 还原停顿） ---
{
  // 真实「前向填充」：静音后首个 token「后」起点被前移到上一 token 末点(2.0)、时长把 [2,12]
  // 静音吃进去并伸进后段 [12,14] → 与后段有交集被 anchored 收敛到 [12,12.3]，停顿复现。
  const filled = [
    T('00:00:00,000', '00:00:01,000', '前'),
    T('00:00:01,000', '00:00:02,000', '段'),
    T('00:00:02,000', '00:00:12,300', '后'),
    T('00:00:12,300', '00:00:12,600', '段'),
  ];
  const segs = [
    { start: 0, end: 2 },
    { start: 12, end: 14 },
  ];
  eq(
    groupTokenCues(retimeTokensToSpeech(filled, segs)),
    [
      ['00:00:00,000', '00:00:02,000', '前段'],
      ['00:00:12,000', '00:00:12,600', '后段'],
    ],
    'retime+group: forward-filled token anchored into next segment, gap restored',
  );
}

// --- subtitleSegmentation: retime+group 端到端（D11：句尾尾字回贴上一句，不另起迟到条） ---
{
  // 「應用」在前段，尾字「廣泛。」被 whisper 放到 VAD 末点之外的静音里，且离前段更近 →
  // 整 run 回贴前段末点、与「應用」聚成同一条，而非在 53s 处另起一条迟到的「廣泛」。
  const tokens = [
    T('00:00:44,960', '00:00:48,000', '應'),
    T('00:00:48,000', '00:00:49,916', '用'),
    T('00:00:49,916', '00:00:50,200', '廣'),
    T('00:00:50,200', '00:00:50,500', '泛'),
    T('00:00:50,500', '00:00:50,500', '。'),
  ];
  const segs = [
    { start: 44.96, end: 49.916 },
    { start: 53.862, end: 56.76 },
  ];
  const cues = groupTokenCues(retimeTokensToSpeech(tokens, segs));
  eq(
    cues.length,
    1,
    'retime+group: trailing tail merges into one cue (no late cue)',
  );
  eq(
    cues[0][2],
    '應用廣泛。',
    'retime+group: trailing tail text joins previous sentence',
  );
  eq(
    cues[0][0],
    '00:00:44,960',
    'retime+group: merged cue keeps previous sentence start',
  );
}

// --- subtitleSegmentation: retime+group 端到端（D11：零时长整句被前向填充 → 消除零时长孤条） ---
{
  // 复现「人工智能技术」整句被 whisper 塞成同一时刻零时长、落在静音里（旧版输出
  // 00:00:41,400 --> 00:00:41,400 人工智能技术 的零时长字幕条）。run 离后段更近 → 前向贴到
  // 后段起点，与「正在」聚成同一条非零时长字幕，零时长孤条消失。
  const zeroRun = [
    T('00:00:36,000', '00:00:36,956', '号'),
    T('00:00:41,400', '00:00:41,400', '人'),
    T('00:00:41,400', '00:00:41,400', '工'),
    T('00:00:41,400', '00:00:41,400', '智'),
    T('00:00:41,400', '00:00:41,400', '能'),
    T('00:00:41,400', '00:00:41,400', '技'),
    T('00:00:41,400', '00:00:41,400', '术'),
    T('00:00:41,926', '00:00:43,400', '正'),
    T('00:00:43,400', '00:00:44,960', '在'),
  ];
  const segs = [
    { start: 30, end: 36.956 },
    { start: 41.926, end: 44.96 },
  ];
  eq(
    groupTokenCues(retimeTokensToSpeech(zeroRun, segs)),
    [
      ['00:00:36,000', '00:00:36,956', '号'],
      ['00:00:41,926', '00:00:44,960', '人工智能技术正在'],
    ],
    'retime+group: zero-duration filled sentence merged forward (no zero-length cue)',
  );
}

// --- subtitleSegmentation: clampCuesToSegments（cue 起止收进真实语音段，D8-B） ---
{
  const segs = [
    { start: 0, end: 2 },
    { start: 12, end: 14 },
  ];
  // 起点渗进静音的跨停顿 cue → 收进重叠段 [12,14]，停顿复现
  eq(
    clampCuesToSegments([T('00:00:05,000', '00:00:13,000', '后段')], segs),
    [['00:00:12,000', '00:00:13,000', '后段']],
    'clamp: cue bleeding into silence clamped to overlapping segment',
  );
  // 与任何语音段都无重叠的 cue → 原样返回（不臆断）
  eq(
    clampCuesToSegments([T('00:00:05,000', '00:00:06,000', '幻')], segs),
    [['00:00:05,000', '00:00:06,000', '幻']],
    'clamp: cue with no overlapping segment kept as-is',
  );
  // 空 segments → 原样返回（优雅降级）
  eq(
    clampCuesToSegments([T('00:00:05,000', '00:00:13,000', 'x')], []),
    [['00:00:05,000', '00:00:13,000', 'x']],
    'clamp: empty segments returns cues unchanged',
  );
  // 自身起止已落在重叠段内的多段 cue → 保持原界（不打洞中间静音）
  eq(
    clampCuesToSegments([T('00:00:01,000', '00:00:13,500', '整')], segs),
    [['00:00:01,000', '00:00:13,500', '整']],
    'clamp: cue overlapping multiple segments keeps its own inner bounds',
  );
}

// --- subtitleSegmentation: clampCuesToDominantSegments（VAD-off 安全停顿还原，D13） ---
{
  const segs = [
    { start: 10, end: 13 },
    { start: 20, end: 22 },
  ];
  // 带前导静音、实质覆盖某段（≥50%）→ 剪掉前导静音、收进段内，复现 gap
  eq(
    clampCuesToDominantSegments(
      [T('00:00:05,000', '00:00:13,000', '后段')],
      segs,
    ),
    [['00:00:10,000', '00:00:13,000', '后段']],
    'clampDom: leading-silence cue covering a segment is clamped into it',
  );
  // 只擦到前句段尾的弱重叠（覆盖率 < 50%）→ 原样保留（不被误夹成碎片，修 clampCuesToSegments 把「请记录」夹成 0.3s）
  eq(
    clampCuesToDominantSegments(
      [T('00:00:08,000', '00:00:10,500', '弱')],
      segs,
    ),
    [['00:00:08,000', '00:00:10,500', '弱']],
    'clampDom: weak tail overlap (<50% coverage) kept as-is, not squeezed',
  );
  // 与任何语音段无重叠 → 原样（交给 dropCuesInDeepSilence 判幻觉）
  eq(
    clampCuesToDominantSegments(
      [T('00:00:15,000', '00:00:16,000', '幻')],
      segs,
    ),
    [['00:00:15,000', '00:00:16,000', '幻']],
    'clampDom: cue with no overlapping segment kept as-is',
  );
  // 实质覆盖两段 → 收到 [首段 start, 末段 end]，剪掉两端静音、保留两段（含中间停顿）
  eq(
    clampCuesToDominantSegments(
      [T('00:00:05,000', '00:00:25,000', '两段')],
      segs,
    ),
    [['00:00:10,000', '00:00:22,000', '两段']],
    'clampDom: cue covering two full segments clamps to [first.start,last.end]',
  );
  // 空 segments（边界源不可用）→ 原样返回（优雅降级）
  eq(
    clampCuesToDominantSegments([T('00:00:05,000', '00:00:13,000', 'x')], []),
    [['00:00:05,000', '00:00:13,000', 'x']],
    'clampDom: empty segments returns cues unchanged (graceful degradation)',
  );
  // 收敛后时长 < 0.3s → 放弃收敛、保留可读原 cue
  eq(
    clampCuesToDominantSegments(
      [T('00:00:09,000', '00:00:10,200', '短')],
      [{ start: 10, end: 10.2 }],
    ),
    [['00:00:09,000', '00:00:10,200', '短']],
    'clampDom: clamped result shorter than min duration keeps original',
  );
  // cue 完整落在长段内（覆盖率 < 50%）→ 原样（本就在有声区、无静音可剪）
  eq(
    clampCuesToDominantSegments(
      [T('00:00:12,000', '00:00:13,000', '内')],
      [{ start: 10, end: 20 }],
    ),
    [['00:00:12,000', '00:00:13,000', '内']],
    'clampDom: cue fully inside a long segment kept (no silence to trim)',
  );
  // 覆盖率阈值可配置：调低到 0.1 → 弱重叠也会被收敛
  eq(
    clampCuesToDominantSegments(
      [T('00:00:08,000', '00:00:10,500', '弱')],
      segs,
      {
        minSegmentCoverage: 0.1,
      },
    ),
    [['00:00:10,000', '00:00:10,500', '弱']],
    'clampDom: lower coverage threshold also clamps weak overlap',
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

// --- subtitleSegmentation: dropCuesInDeepSilence（VAD-off 路径护栏，D12） ---
{
  const segs = [
    { start: 0, end: 5 },
    { start: 20, end: 25 },
  ];
  // 深静音悬空 cue（离最近段 5s）丢；贴边界真实尾字/起字（0.5s / 0.2s）与重叠 cue 保留
  eq(
    dropCuesInDeepSilence(
      [
        T('00:00:02,000', '00:00:03,000', '好'), // 与 [0,5] 重叠 → 留
        T('00:00:05,500', '00:00:06,000', '泛'), // 距前段 0.5s → 留（VAD 漏检尾字）
        T('00:00:10,000', '00:00:11,000', '幻'), // 离最近段 5s → 丢（深静音幻觉）
        T('00:00:19,000', '00:00:19,800', '請'), // 距后段 0.2s → 留（VAD 漏检起字）
      ],
      segs,
    ),
    [
      ['00:00:02,000', '00:00:03,000', '好'],
      ['00:00:05,500', '00:00:06,000', '泛'],
      ['00:00:19,000', '00:00:19,800', '請'],
    ],
    'drop: deep-silence cue removed, boundary-adjacent real speech kept',
  );
  // 空 segments（边界源不可用）→ 原样返回（优雅降级，绝不无依据删字幕）
  eq(
    dropCuesInDeepSilence([T('00:00:10,000', '00:00:11,000', '幻')], []),
    [['00:00:10,000', '00:00:11,000', '幻']],
    'drop: empty segments returns cues unchanged (graceful degradation)',
  );
  // 更严阈值（0.3s）→ 连贴边界 0.5s 的 cue 也丢
  eq(
    dropCuesInDeepSilence([T('00:00:05,500', '00:00:06,000', '泛')], segs, {
      minSilenceDistanceSeconds: 0.3,
    }),
    [],
    'drop: stricter distance threshold also drops near-boundary cue',
  );
  // 不修改保留 cue 的时间 / 文本（只整条保留或丢弃）
  eq(
    dropCuesInDeepSilence([T('00:00:01,234', '00:00:04,567', '原样')], segs),
    [['00:00:01,234', '00:00:04,567', '原样']],
    'drop: kept cue is returned verbatim (no retiming)',
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

console.log(`\nengine unit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
