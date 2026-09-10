import fs from 'fs/promises';
import path from 'path';

export type SubtitlePathOperations = Pick<
  typeof fs,
  'readdir' | 'stat' | 'lstat'
>;

/** Inspect an existing directory entry, without creating probe files in user directories. */
async function isCaseSensitive(
  directory: string,
  operations: SubtitlePathOperations,
): Promise<boolean> {
  const entries = await operations.readdir(directory);
  for (const entry of entries) {
    const alternate = entry.replace(/[a-zA-Z]/, (letter) =>
      letter === letter.toLowerCase()
        ? letter.toUpperCase()
        : letter.toLowerCase(),
    );
    if (alternate === entry) continue;
    if (entries.includes(alternate)) return true;
    const original = await operations.lstat(path.join(directory, entry));
    try {
      const other = await operations.lstat(path.join(directory, alternate));
      return original.dev !== other.dev || original.ino !== other.ino;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  // Every export directory contains a canonical SRT; do not guess if it disappears.
  throw new Error(
    `Cannot determine subtitle directory case sensitivity: ${directory}`,
  );
}

/** Directory inode + filesystem-aware basename also catches symlinked parent aliases. */
export function createSubtitlePathIdentity(
  operations: SubtitlePathOperations = fs,
) {
  const directories = new Map<
    string,
    { key: string; caseSensitive: boolean }
  >();
  return async (
    filePath: string,
  ): Promise<{ name: string; inode?: string }> => {
    const directory = path.dirname(path.resolve(filePath));
    let identity = directories.get(directory);
    if (!identity) {
      const stat = await operations.stat(directory);
      identity = {
        key: `${stat.dev}:${stat.ino}`,
        caseSensitive: await isCaseSensitive(directory, operations),
      };
      directories.set(directory, identity);
    }
    const basename = path.basename(filePath);
    const name = `${identity.key}/${identity.caseSensitive ? basename : basename.normalize('NFC').toLowerCase()}`;
    try {
      const stat = await operations.stat(filePath);
      return { name, inode: `${stat.dev}:${stat.ino}` };
    } catch (error) {
      if (error.code === 'ENOENT') return { name };
      throw error;
    }
  };
}
