import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type {
  ComposePublicationState,
  PublishedFileIdentity,
} from './composeOutput';

const identitySchema = z.object({
  dev: z.number().finite(),
  ino: z.number().finite(),
  size: z.number().nonnegative(),
  mtimeMs: z.number().finite(),
});
const publicationSchema = z.object({
  directory: z.string(),
  identity: identitySchema,
  phase: z.enum(['created', 'publishing', 'published']),
  files: z
    .array(
      z.object({
        source: z.string(),
        target: z.string(),
        sourceIdentity: identitySchema,
        mode: z.enum(['link', 'copy']),
        owned: identitySchema.optional(),
        complete: z.boolean().optional(),
      }),
    )
    .max(10),
});
const stat = (file: string) => {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
const sameNode = (a: fs.Stats, b: PublishedFileIdentity) =>
  a.dev === b.dev && a.ino === b.ino;
const sameContent = (a: fs.Stats, b: PublishedFileIdentity) =>
  sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Recover only recorded paths; never scan output folders or remove replacements. */
export function inspectPublication(value: unknown) {
  const record = publicationSchema.parse(value) as ComposePublicationState;
  const directory = record.directory;
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !/^\.smartsub-compose-[a-zA-Z0-9]{6}$/.test(path.basename(directory))
  )
    throw new Error('Invalid export recovery directory');
  const parent = path.dirname(directory);
  if (
    record.files.some(
      (file) =>
        path.dirname(file.source) !== directory ||
        path.dirname(file.target) !== parent ||
        path.resolve(file.source) !== file.source ||
        path.resolve(file.target) !== file.target,
    )
  )
    throw new Error('Export recovery paths escaped the recorded directory');
  const dirStat = stat(directory);
  if (
    dirStat &&
    (!dirStat.isDirectory() || !sameNode(dirStat, record.identity))
  )
    throw new Error('Export recovery directory has been replaced');
  const files = record.files.map((file) => {
    const target = stat(file.target);
    const expected = file.mode === 'link' ? file.sourceIdentity : file.owned;
    const owned = target?.isFile() && expected && sameNode(target, expected);
    const complete =
      owned &&
      sameContent(target, expected) &&
      (file.mode === 'link' || file.complete) &&
      target.size === file.sourceIdentity.size;
    return { file, owned, complete };
  });
  const complete = files.length > 0 && files.every((file) => file.complete);
  return {
    complete,
    paths: complete ? files.map(({ file }) => file.target) : [],
    cleanup: (rollback = true) => {
      if (rollback && !complete)
        for (const { file, owned } of files) {
          const expected =
            file.mode === 'link' ? file.sourceIdentity : file.owned;
          const current = stat(file.target);
          if (
            owned &&
            expected &&
            current?.isFile() &&
            (file.mode === 'copy' && !file.complete
              ? sameNode(current, expected)
              : sameContent(current, expected))
          )
            fs.unlinkSync(file.target);
        }
      const current = stat(directory);
      if (current?.isDirectory() && sameNode(current, record.identity))
        fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
