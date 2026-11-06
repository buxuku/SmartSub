import { createHash } from 'crypto';

export type ProviderHealthKind = 'asr' | 'translation' | 'tts';
export interface ProviderHealth {
  kind: ProviderHealthKind;
  id: string;
  status: 'connected' | 'failed';
  checkedAt: number;
}

const results = new Map<string, ProviderHealth>();
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_RESULTS = 256;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((name) => [name, canonicalize(value[name])]),
  );
}

function key(
  kind: ProviderHealthKind,
  provider: Record<string, unknown>,
): string {
  // Cache identity includes configuration, so changing credentials invalidates a test.
  const { strictStructuredOutput: _testOnly, ...configuration } = provider;
  return `${kind}:${createHash('sha256')
    .update(JSON.stringify(canonicalize(configuration)))
    .digest('hex')}`;
}

function prune(now: number): void {
  for (const [cacheKey, result] of results) {
    if (now < result.checkedAt || now - result.checkedAt >= MAX_AGE_MS)
      results.delete(cacheKey);
  }
}

export function recordProviderHealth(
  kind: ProviderHealthKind,
  provider: Record<string, unknown>,
  ok: boolean,
): void {
  const now = Date.now();
  prune(now);
  const cacheKey = key(kind, provider);
  results.delete(cacheKey);
  results.set(cacheKey, {
    kind,
    id: String(provider.id),
    status: ok === true ? 'connected' : 'failed',
    checkedAt: now,
  });
  while (results.size > MAX_RESULTS)
    results.delete(results.keys().next().value);
}

export function getProviderHealth(
  kind: ProviderHealthKind,
  provider: Record<string, unknown>,
): ProviderHealth | null {
  prune(Date.now());
  const result = results.get(key(kind, provider));
  return result ? { ...result } : null;
}
