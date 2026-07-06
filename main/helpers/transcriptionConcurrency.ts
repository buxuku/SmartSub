import type { TranscriptionEngine } from '../../types/engine';

const SERIALIZED_TRANSCRIPTION_ENGINES = new Set<TranscriptionEngine>([
  'fasterWhisper',
  'funasr',
  'qwen',
  'fireRedAsr',
]);

export function shouldSerializeTranscriptionEngine(
  engine: TranscriptionEngine,
): boolean {
  return SERIALIZED_TRANSCRIPTION_ENGINES.has(engine);
}

export function createSerialTaskRunner() {
  let queue: Promise<unknown> = Promise.resolve();

  return async function runSerially<T>(task: () => Promise<T>): Promise<T> {
    const previous = queue.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue = previous.then(() => gate);
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
