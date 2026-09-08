import path from 'path';

export const XIAOMI_MIMO_ASR_MODEL = 'mimo-v2.5-asr';
export const XIAOMI_MIMO_MAX_BASE64_BYTES = 10 * 1024 * 1024;

export type XiaomiMimoAsrLanguage = 'auto' | 'zh' | 'en';
export type XiaomiMimoAudioFormat = 'wav' | 'mp3';

export function normalizeXiaomiMimoAsrLanguage(
  language?: string,
): XiaomiMimoAsrLanguage {
  const normalized = language?.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized || normalized === 'auto') return 'auto';
  if (
    normalized === 'zh' ||
    normalized.startsWith('zh-') ||
    normalized === 'yue'
  )
    return 'zh';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  throw new Error(
    `Xiaomi MiMo ASR supports only Chinese, English, or auto detection (received: ${language})`,
  );
}

export function xiaomiMimoAudioFormat(
  audioPath: string,
): XiaomiMimoAudioFormat {
  const ext = path.extname(audioPath).toLowerCase();
  if (ext === '.wav') return 'wav';
  if (ext === '.mp3') return 'mp3';
  throw new Error('Xiaomi MiMo ASR accepts only WAV or MP3 audio');
}

export function buildXiaomiMimoAsrBody(opts: {
  data: string;
  format: XiaomiMimoAudioFormat;
  language?: string;
}): Record<string, unknown> {
  if (Buffer.byteLength(opts.data, 'utf8') > XIAOMI_MIMO_MAX_BASE64_BYTES) {
    throw new Error('Xiaomi MiMo ASR: Base64 audio exceeds the 10 MB limit');
  }
  return {
    model: XIAOMI_MIMO_ASR_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: opts.data, format: opts.format },
          },
        ],
      },
    ],
    asr_options: {
      language: normalizeXiaomiMimoAsrLanguage(opts.language),
    },
    stream: false,
  };
}

export function parseXiaomiMimoAsrResponse(raw: unknown): {
  text: string;
  duration?: number;
} {
  const data = (raw ?? {}) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { seconds?: unknown };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(
      'Xiaomi MiMo ASR: response did not contain transcript text',
    );
  }
  const seconds = Number(data.usage?.seconds);
  return {
    text: content,
    duration: Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
  };
}

export function isRetryableXiaomiMimoAsrStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503;
}
