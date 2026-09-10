export const XIAOMI_MIMO_TTS_MODEL = 'mimo-v2.5-tts';
export const XIAOMI_MIMO_TTS_VOICES = [
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
] as const;

export function buildXiaomiMimoTtsBody(opts: {
  text: string;
  voice: string;
}): Record<string, unknown> {
  return {
    model: XIAOMI_MIMO_TTS_MODEL,
    messages: [{ role: 'assistant', content: opts.text }],
    audio: { format: 'wav', voice: opts.voice },
    stream: false,
  };
}

export function parseXiaomiMimoTtsResponse(raw: unknown): Buffer {
  const data = (raw ?? {}) as {
    choices?: Array<{ message?: { audio?: { data?: unknown } } }>;
  };
  const encoded = data.choices?.[0]?.message?.audio?.data;
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error('Xiaomi MiMo TTS: response did not contain audio data');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (audio.length === 0) {
    throw new Error('Xiaomi MiMo TTS: empty audio response');
  }
  return audio;
}
