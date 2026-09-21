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

// Keep the original module path available to manuscript-specific callers while
// sharing the canonical snapshot policy with the rest of the task pipeline.
export { isPinnedTaskConfigSnapshot } from './taskSnapshot';
