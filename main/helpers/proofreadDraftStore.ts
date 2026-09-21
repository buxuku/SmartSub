import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

/** A synchronous acknowledgement means the complete snapshot is on disk. */
export function createProofreadDraftStore(directory: string) {
  const fileFor = (key: string) => {
    if (
      typeof key !== 'string' ||
      !key.startsWith('smartsub_proofread_draft_v1:')
    )
      throw new Error('Invalid proofread draft key');
    return path.join(
      directory,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  };
  return {
    read(key: string): string | null {
      try {
        return fs.readFileSync(fileFor(key), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(key: string, raw: string | null): void {
      const file = fileFor(key);
      if (
        raw !== null &&
        (typeof raw !== 'string' || raw.length > 64 * 1024 * 1024)
      )
        throw new Error('Invalid proofread draft');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        // Keep a tombstone after save/discard: stale Chromium storage must not
        // resurrect a legacy draft after an abrupt exit during migration.
        fs.writeFileSync(fd, raw ?? 'null', 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try {
          fs.unlinkSync(temp);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    },
  };
}
