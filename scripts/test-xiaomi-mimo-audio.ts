/// <reference path="./test-globals.d.ts" />
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ASR_XIAOMI_MIMO,
  ASR_OPENAI_COMPATIBLE,
  ASR_PROVIDER_TYPES,
  buildCloudViews,
  buildInstanceFromPreset,
  getAsrProviderType,
  isAsrProviderConfigured,
  resolveAudioLimits,
  shouldPreChunkAsr,
} from '../types/asrProvider';
import {
  TTS_XIAOMI_MIMO,
  TTS_PROVIDER_TYPES,
  buildTtsViews,
  buildTtsInstanceFromPreset,
  getTtsProviderType,
  isTtsProviderConfigured,
  parseTtsVoices,
  resolveTtsRequestIntervalMs,
} from '../types/ttsProvider';
import {
  normalizeXiaomiMimoBaseURL,
  xiaomiMimoChatURL,
} from '../main/service/xiaomiMimoUtils';
import {
  XIAOMI_MIMO_MAX_BASE64_BYTES,
  buildXiaomiMimoAsrBody,
  isRetryableXiaomiMimoAsrStatus,
  normalizeXiaomiMimoAsrLanguage,
  parseXiaomiMimoAsrResponse,
} from '../main/service/asr/xiaomiMimoUtils';
import {
  XIAOMI_MIMO_TTS_VOICES,
  buildXiaomiMimoTtsBody,
  parseXiaomiMimoTtsResponse,
} from '../main/service/tts/xiaomiMimoUtils';
import { synthesizeWithXiaomiMimo } from '../main/service/tts/xiaomiMimo';
import { transcribeWithXiaomiMimo } from '../main/service/asr/xiaomiMimo';
import { getEngineModelGroups } from '../renderer/lib/engineModels';
import {
  readWavInfo,
  writePcmAsWav,
} from '../main/helpers/dubbing/audioPipeline';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else {
    failed += 1;
    console.error(
      `FAIL ${name}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`,
    );
  }
}

function ok(value: unknown, name: string): void {
  if (value) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function throws(fn: () => unknown, pattern: RegExp, name: string): void {
  try {
    fn();
    failed += 1;
    console.error(`FAIL ${name}: did not throw`);
  } catch (error) {
    ok(error instanceof Error && pattern.test(error.message), name);
  }
}

eq(
  normalizeXiaomiMimoBaseURL(
    'https://token-plan-cn.xiaomimimo.com/v1/chat/completions/',
  ),
  'https://token-plan-cn.xiaomimimo.com/v1',
  'normalizes Token Plan URL and pasted endpoint',
);
eq(
  xiaomiMimoChatURL('https://api.xiaomimimo.com/v1/'),
  'https://api.xiaomimimo.com/v1/chat/completions',
  'builds chat completions URL',
);
throws(
  () => normalizeXiaomiMimoBaseURL('file:///tmp'),
  /http:\/\/ or https:\/\//,
  'rejects non-http URL',
);

eq(normalizeXiaomiMimoAsrLanguage(), 'auto', 'ASR language defaults to auto');
eq(normalizeXiaomiMimoAsrLanguage('zh-Hant'), 'zh', 'maps zh locale');
eq(normalizeXiaomiMimoAsrLanguage('yue'), 'zh', 'maps Cantonese to Chinese');
eq(normalizeXiaomiMimoAsrLanguage('en_US'), 'en', 'maps en locale');
throws(
  () => normalizeXiaomiMimoAsrLanguage('ja'),
  /only Chinese, English/,
  'rejects unsupported explicit ASR language',
);

const asrBody = buildXiaomiMimoAsrBody({
  data: 'YWJj',
  format: 'wav',
  language: 'zh-CN',
});
eq(
  asrBody,
  {
    model: 'mimo-v2.5-asr',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: 'YWJj', format: 'wav' },
          },
        ],
      },
    ],
    asr_options: { language: 'zh' },
    stream: false,
  },
  'builds exact ASR body',
);
throws(
  () =>
    buildXiaomiMimoAsrBody({
      data: 'x'.repeat(XIAOMI_MIMO_MAX_BASE64_BYTES + 1),
      format: 'wav',
    }),
  /10 MB/,
  'rejects ASR base64 over 10 MB',
);
eq(
  parseXiaomiMimoAsrResponse({
    choices: [{ message: { content: '你好。' } }],
    usage: { seconds: 2 },
  }),
  { text: '你好。', duration: 2 },
  'parses ASR response text and duration',
);
eq(
  [400, 429, 500, 503].map(isRetryableXiaomiMimoAsrStatus),
  [false, true, true, true],
  'retries only documented transient ASR statuses',
);

const asrType = getAsrProviderType(ASR_XIAOMI_MIMO)!;
const asr = buildInstanceFromPreset(asrType, undefined, () => 'mimo-asr');
eq(asr.models, 'mimo-v2.5-asr', 'ASR defaults to fixed model');
eq(asr.requestInterval, 0.7, 'ASR defaults request interval to 0.7s');
eq(shouldPreChunkAsr(asrType), true, 'MiMo ASR pre-chunks before requests');
eq(
  shouldPreChunkAsr(getAsrProviderType(ASR_OPENAI_COMPATIBLE)),
  false,
  'existing ASR providers keep the dynamic timestamp path',
);
eq(
  resolveAudioLimits(asrType, {
    maxUploadBytes: 99,
    maxChunkSeconds: 99,
  }),
  { maxUploadBytes: 7 * 1024 * 1024, maxChunkSeconds: 20 },
  'MiMo ASR uses safe upload and 20-second chunk limits',
);
eq(isAsrProviderConfigured(asr), false, 'ASR needs API key');
asr.apiKey = 'test-key';
eq(isAsrProviderConfigured(asr), true, 'ASR is ready with defaults and key');
ok(
  ASR_PROVIDER_TYPES.some((type) => type.id === ASR_XIAOMI_MIMO),
  'ASR provider is registered',
);
eq(
  buildCloudViews([]).filter((view) => view.type.id === ASR_XIAOMI_MIMO).length,
  1,
  'ASR provider has one permanent brand view',
);
eq(
  getEngineModelGroups(undefined, { asrProviders: [asr] })[0]?.coarseTimeline,
  true,
  'MiMo model group carries the coarse timeline flag',
);

const ttsBody = buildXiaomiMimoTtsBody({
  text: '你好',
  voice: '冰糖',
});
eq(
  ttsBody,
  {
    model: 'mimo-v2.5-tts',
    messages: [{ role: 'assistant', content: '你好' }],
    audio: { format: 'wav', voice: '冰糖' },
    stream: false,
  },
  'builds exact TTS body without style or native speed',
);
eq(
  [...XIAOMI_MIMO_TTS_VOICES],
  ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
  'exposes exactly eight fixed TTS voices',
);
throws(
  () => parseXiaomiMimoTtsResponse({ choices: [{}] }),
  /audio data/,
  'rejects missing TTS audio',
);

const ttsType = getTtsProviderType(TTS_XIAOMI_MIMO)!;
const tts = buildTtsInstanceFromPreset(ttsType, undefined, () => 'mimo-tts');
eq(tts.model, 'mimo-v2.5-tts', 'TTS defaults to fixed model');
eq(tts.requestInterval, 0.7, 'TTS defaults request interval to 0.7s');
eq(resolveTtsRequestIntervalMs(tts), 700, 'TTS applies configured pacing');
eq(
  resolveTtsRequestIntervalMs({ id: 'old', name: 'old', type: 'old' }),
  0,
  'TTS legacy providers keep zero pacing',
);
eq(parseTtsVoices(tts), [...XIAOMI_MIMO_TTS_VOICES], 'TTS voice defaults');
eq(isTtsProviderConfigured(tts), false, 'TTS needs API key');
tts.apiKey = 'test-key';
eq(isTtsProviderConfigured(tts), true, 'TTS is ready with defaults and key');
ok(
  TTS_PROVIDER_TYPES.some((type) => type.id === TTS_XIAOMI_MIMO),
  'TTS provider is registered',
);
eq(
  buildTtsViews([]).filter((view) => view.type.id === TTS_XIAOMI_MIMO).length,
  1,
  'TTS provider has one permanent brand view',
);

async function run(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-audio-test-'));
  const responseWav = path.join(tempDir, 'response.wav');
  const outWav = path.join(tempDir, 'out.wav');
  writePcmAsWav(Buffer.alloc(24000 * 2), 24000, responseWav);
  const responseData = fs.readFileSync(responseWav).toString('base64');
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { audio: { data: responseData } } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const result = await synthesizeWithXiaomiMimo(tts, {
      text: '你好',
      voice: '冰糖',
      speed: 2,
      outWavPath: outWav,
    });
    const info = readWavInfo(outWav);
    eq(info.sampleRate, 24000, 'TTS normalizes to 24 kHz');
    eq(info.channels, 1, 'TTS normalizes to mono');
    eq(info.bitsPerSample, 16, 'TTS normalizes to PCM16');
    ok(
      result.durationMs >= 450 && result.durationMs <= 550,
      'TTS applies request speed with atempo',
    );
    ok(
      requestBody !== undefined && !('speed' in requestBody),
      'TTS does not send unsupported native speed',
    );

    let asrCalls = 0;
    globalThis.fetch = (async () => {
      asrCalls += 1;
      if (asrCalls === 1) {
        return new Response('{"error":{"message":"slow down"}}', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '你好。' } }],
          usage: { seconds: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const asrResult = await transcribeWithXiaomiMimo(asr, {
      audioPath: responseWav,
      model: 'mimo-v2.5-asr',
      language: 'zh-CN',
    });
    eq(asrCalls, 2, 'ASR retries HTTP 429');
    eq(asrResult.text, '你好。', 'ASR service parses retried response');
    eq(asrResult.hasWordTimestamps, false, 'ASR reports no word timestamps');

    let malformedCalls = 0;
    globalThis.fetch = (async () => {
      malformedCalls += 1;
      return new Response('{"choices":[{}]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    let malformedError: unknown;
    try {
      await transcribeWithXiaomiMimo(asr, {
        audioPath: responseWav,
        model: 'mimo-v2.5-asr',
      });
    } catch (error) {
      malformedError = error;
    }
    eq(malformedCalls, 1, 'ASR does not retry malformed successful responses');
    ok(
      malformedError instanceof Error &&
        /transcript text/.test(malformedError.message),
      'ASR surfaces malformed response errors',
    );

    const cancelled = new AbortController();
    cancelled.abort();
    let cancelError: unknown;
    try {
      await transcribeWithXiaomiMimo(asr, {
        audioPath: responseWav,
        model: 'mimo-v2.5-asr',
        signal: cancelled.signal,
      });
    } catch (error) {
      cancelError = error;
    }
    ok(
      cancelError instanceof Error && cancelError.message === 'TASK_CANCELLED',
      'ASR respects a pre-aborted signal',
    );

    let ttsFailureCalls = 0;
    globalThis.fetch = (async () => {
      ttsFailureCalls += 1;
      return new Response('{"error":{"message":"busy"}}', { status: 503 });
    }) as typeof fetch;
    let ttsFailure: unknown;
    try {
      await synthesizeWithXiaomiMimo(tts, {
        text: '你好',
        voice: '冰糖',
        outWavPath: outWav,
      });
    } catch (error) {
      ttsFailure = error;
    }
    eq(ttsFailureCalls, 1, 'TTS does not retry failed requests');
    ok(
      ttsFailure instanceof Error && /HTTP 503 - busy/.test(ttsFailure.message),
      'TTS surfaces API error detail',
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run()
  .catch((error) => {
    failed += 1;
    console.error(`FAIL async MiMo audio tests: ${error}`);
  })
  .finally(() => {
    console.log(`\nMiMo audio tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
