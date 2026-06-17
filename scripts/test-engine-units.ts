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
import {
  getFunasrAsrModelIds,
  resolveFunasrAsrSelection,
} from '../main/helpers/funasrModelCatalog';
import {
  buildVadConfig,
  buildRecognizerConfig,
  segmentTiming,
  progressPercent,
} from '../main/helpers/sherpaOnnx/sherpaConfig';
import {
  getSelectableModelsForEngine,
  getInstalledModelsForEngine,
  hasModelsForEngine,
} from '../renderer/lib/engineModels';

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
    vadSpeechPad: 30,
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
    artifacts: {},
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
    artifacts: {},
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
  'https://ghfast.top/https://github.com/buxuku/whisper.cpp/releases/download/latest',
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
  'https://ghfast.top/https://github.com/buxuku/smartsub-py-engine/releases/download/latest',
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

console.log(`\nengine unit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
