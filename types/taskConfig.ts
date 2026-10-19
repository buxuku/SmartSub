/**
 * Reference manuscripts are task inputs, not reusable user preferences.
 * Keep these helpers dependency-free so main and renderer enforce the same rule.
 */
export function assertTaskConfig(
  config: unknown,
): asserts config is Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('INVALID_USER_CONFIG_RESPONSE');
}

/**
 * Seed a new task from the saved preferences. The task type only says which page/goal
 * the task belongs to: the output style is the user's saved choice for every type, and
 * when nothing was saved the factory default (translation only) is already in the
 * preferences. Restored drafts and execution snapshots bypass this.
 */
export function newTaskDefaults(
  preferences: Record<string, any>,
  taskType: string,
): Record<string, any> {
  return { ...preferences, taskType };
}

export function omitTaskManuscript<
  T extends Record<string, any> | null | undefined,
>(config: T): Record<string, any> {
  const source = (config || {}) as Record<string, any>;
  const {
    manuscriptPath: _manuscriptPath,
    manuscriptName: _manuscriptName,
    ...rest
  } = source;
  return rest;
}

/**
 * Inputs of one single task rather than preferences. Everything else the user picks
 * while editing a task is a preference; there is deliberately no allow-list, so a setting
 * added later is remembered without anyone having to register it here.
 *
 * - taskType: decided by the page/goal and re-applied by `newTaskDefaults`
 * - dub / compose / gates: pipeline stages configured per task in the wizard
 * - cloudUploadConsent: consent to one upload, never silently inherited
 * - manuscriptPath / manuscriptName: the reference manuscript (see `omitTaskManuscript`)
 */
const PER_TASK_KEYS: ReadonlySet<string> = new Set([
  'taskType',
  'dub',
  'compose',
  'gates',
  'cloudUploadConsent',
  'manuscriptPath',
  'manuscriptName',
]);

/**
 * Whether a task setting is a reusable preference, i.e. may become the default of the
 * next new task. The task page filters its edits with it before sending them; the main
 * process applies the same rule again when it merges them.
 */
export function isTaskDefaultsKey(key: string): boolean {
  return !PER_TASK_KEYS.has(key);
}

/**
 * Merge what the user changed on the task page into the stored defaults ("last used").
 * Only the keys of the patch are touched, so settings an old project or a failed read
 * knows nothing about can never overwrite them; `undefined` removes a key so the factory
 * default applies again. Per-task inputs are ignored, and a stored config that is not a
 * plain object is rebuilt from the patch. Throws on a patch that is not a plain object;
 * never mutates its inputs.
 */
export function applyTaskDefaultsPatch(
  stored: unknown,
  patch: unknown,
): Record<string, any> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('INVALID_TASK_DEFAULTS');
  const next =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? omitTaskManuscript(stored as Record<string, any>)
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, any>)) {
    // `next.__proto__ = value` would swap the prototype instead of storing a setting.
    if (key === '__proto__' || !isTaskDefaultsKey(key)) continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

// Keep the original module path available to manuscript-specific callers while
// sharing the canonical snapshot policy with the rest of the task pipeline.
export { isPinnedTaskConfigSnapshot } from './taskSnapshot';
