import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const unsupportedLinks = new Set([
  'EXDEV',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
]);
const sameFile = (a: fs.Stats, b: fs.Stats) =>
  a.dev === b.dev && a.ino === b.ino;

export interface PublishedFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
export interface ComposePublicationState {
  directory: string;
  identity: PublishedFileIdentity;
  phase: 'created' | 'publishing' | 'published';
  files: Array<{
    source: string;
    target: string;
    sourceIdentity: PublishedFileIdentity;
    mode: 'link' | 'copy';
    owned?: PublishedFileIdentity;
    complete?: boolean;
  }>;
}
const identity = (stat: fs.Stats): PublishedFileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
});

/** Render privately; publish without replacing any source, prior export or concurrent writer. */
export function createComposeOutput(
  desired: string,
  inputs: string[],
  onPublication?: (state: ComposePublicationState) => void,
) {
  if (!path.isAbsolute(desired) || !path.extname(desired))
    throw new Error('Output must be an absolute file path');
  const output = path.resolve(desired);
  const existing = fs.existsSync(output) ? fs.statSync(output) : null;
  if (existing && !existing.isFile())
    throw new Error(`Output is not a file: ${output}`);
  for (const input of inputs) {
    if (
      path.resolve(input) === output ||
      (existing && sameFile(existing, fs.statSync(input)))
    ) {
      throw new Error(`Output cannot replace an input file: ${output}`);
    }
  }
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  // Resolve directory aliases once: cleanup is limited to this unique job directory.
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(parent), '.smartsub-compose-'),
  );
  const state: ComposePublicationState = {
    directory,
    identity: identity(fs.lstatSync(directory)),
    phase: 'created',
    files: [],
  };
  const checkpoint = () => onPublication?.(structuredClone(state));
  try {
    checkpoint();
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const staged = path.join(directory, `result${path.extname(output)}`);
  const parsed = path.parse(
    path.join(fs.realpathSync(parent), path.basename(output)),
  );
  const displayPath = (candidate: string) => {
    try {
      if (fs.realpathSync(parent) === parsed.dir)
        return path.join(parent, path.basename(candidate));
    } catch {
      /* The original directory alias was removed. */
    }
    return candidate;
  };
  type PublishedFile = { path: string; stat: fs.Stats };
  const removeOwned = (file: PublishedFile) => {
    try {
      if (sameFile(file.stat, fs.lstatSync(file.path)))
        fs.unlinkSync(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const publish = async (
    signal: AbortSignal,
    companions: Array<{ stagedPath: string; suffix: string }> = [],
  ): Promise<string> => {
    const extensions = [parsed.ext, ...companions.map((file) => file.suffix)];
    if (
      new Set(extensions).size !== extensions.length ||
      extensions.some((ext) => !/^\.[^/\\]+$/.test(ext))
    )
      throw new Error('Invalid output companion suffix');
    const sources = [staged, ...companions.map((file) => file.stagedPath)];
    for (let index = 0; index < sources.length; index++) {
      const target = path.join(parsed.dir, parsed.name + extensions[index]);
      const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (
        index > 0 &&
        inputs.some(
          (input) =>
            path.resolve(input) === target ||
            (targetStat && sameFile(targetStat, fs.statSync(input))),
        )
      )
        throw new Error(`Output cannot replace an input file: ${target}`);
      const stat = fs.statSync(sources[index]);
      if (!stat.isFile() || !stat.size)
        throw new Error('FFmpeg produced no output');
      try {
        const completed = fs.openSync(sources[index], 'r+');
        try {
          fs.fsyncSync(completed);
        } finally {
          fs.closeSync(completed);
        }
      } catch (error) {
        if (
          ![
            'EPERM',
            'EACCES',
            'EBADF',
            'EINVAL',
            'ENOTSUP',
            'EOPNOTSUPP',
          ].includes((error as NodeJS.ErrnoException).code || '')
        ) {
          throw error;
        }
      }
    }
    const publishOne = async (
      source: string,
      candidate: string,
      record: ComposePublicationState['files'][number],
    ): Promise<PublishedFile> => {
      signal.throwIfAborted();
      try {
        const stat = fs.statSync(source);
        fs.linkSync(source, candidate);
        return { path: candidate, stat };
      } catch (error) {
        if (!unsupportedLinks.has((error as NodeJS.ErrnoException).code || ''))
          throw error;
      }
      // FAT/exFAT/network volumes may not support links. Exclusive creation still
      // preserves existing files; an interrupted copy removes only our own inode.
      record.mode = 'copy';
      checkpoint();
      const handle = await fs.promises.open(candidate, 'wx');
      let owned: fs.Stats | undefined;
      try {
        owned = fs.fstatSync(handle.fd);
        record.owned = identity(owned);
        checkpoint();
        await pipeline(
          fs.createReadStream(source),
          fs.createWriteStream(candidate, { fd: handle.fd, autoClose: false }),
          { signal },
        );
        await handle.sync();
        signal.throwIfAborted();
        record.owned = identity(fs.fstatSync(handle.fd));
        await handle.close();
        record.complete = true;
        checkpoint();
        return { path: candidate, stat: owned };
      } catch (error) {
        await handle.close().catch(() => {});
        if (owned) removeOwned({ path: candidate, stat: owned });
        throw error;
      }
    };
    for (let suffix = 0; suffix < 10000; suffix++) {
      signal.throwIfAborted();
      const stem = `${parsed.name}${suffix ? `_${suffix + 1}` : ''}`;
      const published: PublishedFile[] = [];
      try {
        state.phase = 'publishing';
        state.files = sources.map((source, index) => ({
          source,
          target: path.join(parsed.dir, stem + extensions[index]),
          sourceIdentity: identity(fs.statSync(source)),
          mode: 'link',
        }));
        checkpoint();
        // A group shares one suffix. Roll back only our own entries on a late
        // collision or error; never unlink a concurrent writer's replacement.
        for (let index = 0; index < sources.length; index++) {
          published.push(
            await publishOne(
              sources[index],
              path.join(parsed.dir, stem + extensions[index]),
              state.files[index],
            ),
          );
        }
        signal.throwIfAborted();
        state.phase = 'published';
        checkpoint();
        return displayPath(published[0].path);
      } catch (error) {
        for (const file of published.reverse()) removeOwned(file);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`Too many existing outputs for ${desired}`);
  };
  return {
    staged,
    directory,
    publish,
    cleanup: () => {
      const current = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (!current) return;
      if (
        !current.isDirectory() ||
        current.dev !== state.identity.dev ||
        current.ino !== state.identity.ino
      )
        throw new Error('Export temporary directory has been replaced');
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
