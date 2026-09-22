export const FASTER_WHISPER_COMPUTE_TYPES = [
  'auto',
  'default',
  'float32',
  'float16',
  'bfloat16',
  'int16',
  'int8',
  'int8_float32',
  'int8_float16',
  'int8_bfloat16',
] as const;

export function invalidEngineSettings(
  patch: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter((key) => {
    const value = patch[key];
    switch (key) {
      case 'fasterWhisperDevice':
        return !['auto', 'cpu', 'cuda'].includes(value as string);
      case 'fasterWhisperComputeType':
        return !FASTER_WHISPER_COMPUTE_TYPES.includes(value as any);
      case 'whisperCommand':
        return typeof value !== 'string';
      case 'useLocalWhisper':
        return typeof value !== 'boolean';
      default:
        return false;
    }
  });
}
