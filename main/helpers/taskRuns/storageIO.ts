import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Never follow junctions/symlinks during deletion or migration. */
export async function walkFiles(root: string): Promise<string[]> {
  const stat = await fs.promises.lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`TASK_STORAGE_SYMLINK: ${root}`);
  if (!stat.isDirectory()) return [root];
  const files: string[] = [];
  for (const entry of await fs.promises.readdir(root))
    files.push(...(await walkFiles(path.join(root, entry))));
  return files;
}

/** Conservative GC: even an unrecognized absolute-string field protects its target. */
export function referencedPaths(value: unknown, result = new Set<string>()) {
  if (typeof value === 'string' && path.isAbsolute(value))
    result.add(path.resolve(value));
  else if (Array.isArray(value))
    for (const item of value) referencedPaths(item, result);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) referencedPaths(item, result);
  return result;
}

// Explicit metadata fields only. In particular cue.source/target/text/content are user text.
const pathKeys = new Set([
  'path',
  'filePath',
  'directory',
  'videoPath',
  'mediaPath',
  'audioPath',
  'sourceFile',
  'targetFile',
  'finalTargetFile',
  'subtitlePath',
  'wavFile',
  'srtFile',
  'tempSrtFile',
  'tempAudioFile',
  'audioFile',
  'translatedSrtFile',
  'tempTranslatedSrtFile',
  'tempFinalSubtitleFile',
  'wordTimelineFile',
  'speechReviewFile',
  'speechReviewOriginalFile',
  'speakerSegmentsFile',
  'proofreadDataFile',
  'dubbedTrackPath',
  'shiftedSubtitlePath',
  'inputSubtitlePath',
  'providedSubtitlePath',
  'manuscriptPath',
  'finalVideoPath',
  'internalFinalVideoPath',
  'dubbedAudioPath',
  'sourceSubtitlePath',
  'targetSubtitlePath',
  'sourceSubtitleFiles',
  'translatedSubtitleFiles',
  'historicalProofreadFiles',
]);

export function rewritePaths(
  value: any,
  map: (value: string) => string,
  key = '',
  parent = '',
): any {
  if (typeof value === 'string')
    return path.isAbsolute(value) &&
      (pathKeys.has(key) ||
        /(?:File|Path|Files|Paths|Directory)$/.test(key) ||
        parent === 'files' ||
        (parent === 'internalDeliverables' &&
          ['source', 'target', 'desired'].includes(key)))
      ? map(value)
      : value;
  if (Array.isArray(value))
    return value.map((item) => rewritePaths(item, map, key, parent));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([child, item]) => [
        child,
        rewritePaths(item, map, child, key),
      ]),
    );
  }
  return value;
}
