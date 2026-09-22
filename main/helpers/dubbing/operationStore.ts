import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { assertSessionAvailable, getSessionDir } from './sessionStore';
import { inspectPublication } from '../compose/publicationRecovery';
import type {
  DubbingOperationReceipt,
  DubbingOperationStorage,
} from './operationRegistry';

/** Receipts live inside the session, so transactional deletion includes them. */
export class DubbingOperationStore<T> implements DubbingOperationStorage<T> {
  private directory(sessionId: string) {
    assertSessionAvailable(sessionId);
    return path.join(getSessionDir(sessionId), '.operations');
  }

  read(sessionId: string): DubbingOperationReceipt<T>[] {
    const directory = this.directory(sessionId);
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => {
        const receipt = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        );
        if (
          receipt?.version !== 1 ||
          receipt.sessionId !== sessionId ||
          typeof receipt.requestId !== 'string' ||
          !receipt.requestId ||
          receipt.requestId.length > 128 ||
          createHash('sha256').update(receipt.requestId).digest('hex') +
            '.json' !==
            name ||
          !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
          typeof receipt.channel !== 'string' ||
          !Number.isFinite(receipt.createdAt) ||
          !['pending', 'complete', 'expired'].includes(receipt.status) ||
          (receipt.status === 'complete' &&
            (!receipt.result ||
              typeof receipt.result.success !== 'boolean' ||
              (receipt.result.error !== undefined &&
                typeof receipt.result.error !== 'string')))
        )
          throw new Error(
            'Invalid dubbing operation receipt; original data retained',
          );
        if (receipt.publication) {
          if (
            receipt.channel !== 'dubbing:export' ||
            !Array.isArray(receipt.publication.skippedIndexes) ||
            !receipt.publication.skippedIndexes.every(Number.isInteger)
          )
            throw new Error('Invalid dubbing export recovery receipt');
          const recovery = inspectPublication(receipt.publication);
          if (receipt.status === 'pending' && recovery.complete) {
            receipt.status = 'complete';
            receipt.result = {
              success: true,
              data: {
                outputPath: recovery.paths[0],
                ...(recovery.paths[1]
                  ? { shiftedSubtitlePath: recovery.paths[1] }
                  : {}),
                skippedIndexes: receipt.publication.skippedIndexes,
              },
            };
            // Publish the recovered receipt before removing its staged evidence.
            this.write(receipt);
          }
          recovery.cleanup(receipt.status === 'pending');
          // Successful cleanup must not depend on an old output volume next time.
          delete receipt.publication;
          this.write(receipt);
        }
        return receipt;
      });
  }

  write(receipt: DubbingOperationReceipt<T>): void {
    const directory = this.directory(receipt.sessionId);
    // A missing project must not be resurrected by a late completion.
    fs.statSync(getSessionDir(receipt.sessionId));
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(
      directory,
      createHash('sha256').update(receipt.requestId).digest('hex') + '.json',
    );
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(receipt));
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
  }
}
