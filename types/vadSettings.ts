export const VAD_SETTING_BOUNDS = {
  vadThreshold: { min: 0, max: 1 },
  vadMinSpeechDuration: { min: 0, max: Infinity },
  vadMinSilenceDuration: { min: 0, max: Infinity },
  vadMaxSpeechDuration: { min: 0, max: Infinity },
  vadSpeechPad: { min: 0, max: Infinity },
  vadSamplesOverlap: { min: 0, max: 1 },
} as const;

export function invalidVadSettings(patch: Record<string, unknown>): string[] {
  return Object.entries(VAD_SETTING_BOUNDS)
    .filter(([key, bounds]) => {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
      const value = patch[key];
      return (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < bounds.min ||
        value > bounds.max
      );
    })
    .map(([key]) => key);
}
