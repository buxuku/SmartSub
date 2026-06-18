export enum DownSource {
  HuggingFace = 'huggingface',
  HfMirror = 'hf-mirror',
}

export const MODELS_INSTALLED_ONLY_KEY = 'modelsInstalledOnly';
export const MODELS_TIER_VARIANTS_EXPANDED_KEY = 'modelsTierVariantsExpanded';

export function matchesModelQuery(
  haystack: string | string[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const arr = Array.isArray(haystack) ? haystack : [haystack];
  return arr.some((h) => h?.toLowerCase().includes(q));
}
