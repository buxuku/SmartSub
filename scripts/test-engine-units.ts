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

console.log(`\nengine unit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
