interface SaveGuard {
  isDirty: boolean;
  getIsDirty?: () => boolean;
  onSave?: () => Promise<boolean>;
}

/** Re-read registrations after each save: other editors may change while IPC runs. */
export async function saveNavigationGuards(
  guards: Map<string, SaveGuard>,
): Promise<'saved' | 'failed' | 'changed'> {
  for (const id of Array.from(guards.keys())) {
    const current = guards.get(id);
    if (!current || !(current.getIsDirty?.() ?? current.isDirty)) continue;
    if (!current.onSave || (await current.onSave()) !== true) return 'failed';
  }
  return Array.from(guards.values()).some(
    (guard) => guard.getIsDirty?.() ?? guard.isDirty,
  )
    ? 'changed'
    : 'saved';
}
