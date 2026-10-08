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

/** Apply a goal only when creating a task; restored drafts and execution snapshots bypass this. */
export function newTaskDefaults(
  preferences: Record<string, any>,
  taskType: string,
): Record<string, any> {
  return {
    ...preferences,
    taskType,
    ...(taskType === 'generateAndTranslate'
      ? {
          translateContent:
            preferences.translateContent === 'translateAndSource'
              ? 'translateAndSource'
              : 'sourceAndTranslate',
        }
      : {}),
  };
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
 * Inputs of one single task rather than preferences. Everything else the user picked
 * while editing a task is a preference; there is deliberately no allow-list, so a setting
 * added later is remembered without anyone having to register it here.
 *
 * - taskType: decided by the page/goal and re-applied by `newTaskDefaults`
 * - dub / compose / gates: pipeline stages configured per task in the wizard
 * - cloudUploadConsent: consent to one upload, never silently inherited
 */
const PER_TASK_KEYS = [
  'taskType',
  'dub',
  'compose',
  'gates',
  'cloudUploadConsent',
] as const;

/**
 * The part of a started task's configuration that becomes the default of the next new
 * task ("last used"). Throws when nothing reusable remains, so a bad call can never wipe
 * the defaults. Never mutates its input.
 */
export function toRememberedTaskDefaults(config: unknown): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('INVALID_TASK_DEFAULTS');
  const reusable = omitTaskManuscript(config as Record<string, any>);
  for (const key of PER_TASK_KEYS) delete reusable[key];
  if (Object.keys(reusable).length === 0)
    throw new Error('INVALID_TASK_DEFAULTS');
  return reusable;
}

// Keep the original module path available to manuscript-specific callers while
// sharing the canonical snapshot policy with the rest of the task pipeline.
export { isPinnedTaskConfigSnapshot } from './taskSnapshot';
