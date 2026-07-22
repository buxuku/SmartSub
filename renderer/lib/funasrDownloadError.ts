export type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

const REQUIRED_FILES: Record<FunasrModelId, string[]> = {
  'sensevoice-small': ['model.int8.onnx', 'tokens.txt'],
  'paraformer-zh': ['model.int8.onnx', 'tokens.txt'],
  'silero-vad': ['silero_vad.onnx'],
};

type Translate = (
  key: string,
  values?: Record<string, string>,
) => string;

export interface FunasrDownloadFailureToast {
  title: string;
  description: string;
}

export function isFunasrDownloadCancelled(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : String(error);
  return /\b(cancelled|canceled|abort(?:ed)?)\b/i.test(message);
}

export function formatFunasrDownloadFailureToast(
  t: Translate,
  modelId: FunasrModelId,
  rawError: string,
): FunasrDownloadFailureToast {
  const files = REQUIRED_FILES[modelId].join(', ');
  const details = rawError.trim();
  const fallback = t('engines.funasr.downloadFailedManualHint', {
    files,
  });

  return {
    title: t('engines.funasr.downloadFailed'),
    description: details ? `${details}\n${fallback}` : fallback,
  };
}
