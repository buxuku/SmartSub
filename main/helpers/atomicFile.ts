import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

interface AtomicFileOperations {
  open: typeof fs.open;
  rename: typeof fs.rename;
  rm: typeof fs.rm;
}

export interface AtomicReplaceOptions {
  signal?: AbortSignal;
  /** Dependency seam for deterministic failure-path tests. */
  operations?: AtomicFileOperations;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Atomic file replacement cancelled');
  error.name = 'AbortError';
  throw error;
}

/**
 * Durably writes a sibling temporary file, closes it, then performs one atomic
 * rename over the destination. We never move, truncate, or unlink the original
 * first: if any pre-commit step or the rename fails, the destination is intact.
 */
export async function atomicReplaceTextFile(
  targetPath: string,
  content: string,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const operations = options.operations ?? fs;
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const tempPath = path.join(
    directory,
    `.${baseName}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  try {
    throwIfAborted(options.signal);
    handle = await operations.open(tempPath, 'wx');
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(options.signal);
    await operations.rename(tempPath, targetPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the first failure; cleanup remains best effort.
      }
    }
    try {
      await operations.rm(tempPath, { force: true });
    } catch {
      // A leftover temp is safer than touching the original destination.
    }
    throw error;
  }
}
