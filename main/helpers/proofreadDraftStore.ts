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
        // Keep the key separately so non-window editors can detect which file
        // has unsaved work without loading or changing the draft wire format.
        fs.writeFileSync(`${file}.key`, key, { mode: 0o600 });
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
    /**
     * Keys of the entries that recorded their identity. Entries from before the key
     * sidecar existed, and sidecars that do not hash to their own file, are skipped:
     * nobody can tell which document they belong to.
     */
    list(): string[] {
      let names: string[];
      try {
        names = fs.readdirSync(directory);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const keys: string[] = [];
      for (const name of names) {
        if (!name.endsWith('.json.key')) continue;
        let key: string;
        try {
          key = fs.readFileSync(path.join(directory, name), 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        let expected: string;
        try {
          expected = path.basename(fileFor(key));
        } catch {
          continue;
        }
        if (expected !== name.slice(0, -'.key'.length)) continue;
        keys.push(key);
      }
      return keys;
    },
    /**
     * Deletes the draft and its identity. The data goes first: a crash in between
     * leaves a key without data (harmless, and list() still finds it to finish the
     * job) rather than data nobody can attribute and therefore keeps forever.
     */
    remove(key: string): void {
      const file = fileFor(key);
      for (const target of [file, `${file}.key`]) {
        try {
          fs.unlinkSync(target);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    },
  };
}
