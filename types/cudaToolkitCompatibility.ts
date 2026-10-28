import type { CudaToolkitInfo } from './addon';

/**
 * Lite needs libraries from the same CUDA major and an equal/newer minor.
 * Ignore patch: nvcc reports component builds, not Toolkit release patches.
 * This checks version compatibility, not whether every runtime library can load.
 */
export function isCudaToolkitCompatible(
  toolkit: CudaToolkitInfo | null | undefined,
  addonVersion: string | null | undefined,
): boolean {
  if (!toolkit?.installed || !toolkit.version || !addonVersion) return false;
  const parse = (version: string) => /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  const installed = parse(toolkit.version);
  const required = parse(addonVersion);
  return !!(
    installed &&
    required &&
    Number(installed[1]) === Number(required[1]) &&
    Number(installed[2]) >= Number(required[2])
  );
}
