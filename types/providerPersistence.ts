export type ProviderRecord = { id: string; name: string; type: string };

export function assertProviderList(
  value: unknown,
): asserts value is ProviderRecord[] {
  if (!Array.isArray(value)) throw new Error('INVALID_PROVIDER_LIST');
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id.trim() ||
      ids.has(entry.id) ||
      typeof entry.type !== 'string' ||
      !entry.type.trim() ||
      typeof entry.name !== 'string'
    )
      throw new Error('INVALID_PROVIDER_LIST');
    ids.add(entry.id);
  }
}
