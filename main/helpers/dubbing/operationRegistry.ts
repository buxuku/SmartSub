import { createHash } from 'crypto';
import type { ComposePublicationState } from '../compose/composeOutput';

interface Operation<T> {
  fingerprint: string;
  promise: Promise<T>;
  result?: T;
  complete: boolean;
  receipt: DubbingOperationReceipt<T>;
  interrupted?: boolean;
  persistenceError?: string;
}

export interface DubbingOperationReceipt<T> {
  version: 1;
  sessionId: string;
  requestId: string;
  fingerprint: string;
  channel: string;
  createdAt: number;
  status: 'pending' | 'complete' | 'expired';
  result?: T;
  publication?: ComposePublicationState & { skippedIndexes: number[] };
}

export interface DubbingOperationStorage<T> {
  read(sessionId: string): DubbingOperationReceipt<T>[];
  write(receipt: DubbingOperationReceipt<T>): void;
}

export type DubbingOperationStatus<T> =
  | { status: 'missing' | 'expired' | 'pending' | 'interrupted' }
  | { status: 'complete'; result: T; persistenceError?: string };

/** Retain recent results and tombstones so an evicted request never executes twice. */
export class DubbingOperationRegistry<T> {
  private sessions = new Map<string, Map<string, Operation<T>>>();
  private retired = new Map<string, Map<string, string>>();

  constructor(
    private retainedResults = 32,
    private storage?: DubbingOperationStorage<T>,
  ) {}

  private load(sessionId: string) {
    if (this.sessions.has(sessionId)) return;
    const receipts = this.storage?.read(sessionId) || [];
    const records = new Map<string, Operation<T>>();
    const retired = new Map<string, string>();
    for (const receipt of receipts.sort((a, b) => a.createdAt - b.createdAt)) {
      if (receipt.status === 'expired')
        retired.set(receipt.requestId, receipt.fingerprint);
      else
        records.set(receipt.requestId, {
          receipt,
          fingerprint: receipt.fingerprint,
          complete: receipt.status === 'complete',
          interrupted: receipt.status === 'pending',
          result: receipt.result,
          promise: Promise.resolve(receipt.result),
        });
    }
    this.sessions.set(sessionId, records);
    this.retired.set(sessionId, retired);
  }

  latest(sessionId: string) {
    this.load(sessionId);
    const records = Array.from(this.sessions.get(sessionId)!.values());
    const latest = records[records.length - 1];
    if (!latest) return undefined;
    return {
      requestId: latest.receipt.requestId,
      channel: latest.receipt.channel,
      ...this.status(sessionId, latest.receipt.requestId),
    };
  }

  checkpointPublication(
    sessionId: string,
    requestId: string,
    publication: DubbingOperationReceipt<T>['publication'],
  ): void {
    const record = this.sessions.get(sessionId)?.get(requestId);
    if (
      !record ||
      record.complete ||
      record.interrupted ||
      record.receipt.channel !== 'dubbing:export'
    )
      throw new Error('Export operation is not active');
    const receipt = {
      ...record.receipt,
      publication: structuredClone(publication),
    };
    this.storage?.write(receipt);
    record.receipt = receipt;
  }

  run(
    channel: string,
    payload: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    const { sessionId, requestId, leaseId: _lease, ...input } = payload;
    if (
      typeof sessionId !== 'string' ||
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 128
    )
      throw new Error('Invalid dubbing operation identifier');
    this.load(sessionId);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([channel, input]))
      .digest('hex');
    const records = this.sessions.get(sessionId) || new Map();
    this.sessions.set(sessionId, records);
    const previous = records.get(requestId);
    const retired = this.retired.get(sessionId)?.get(requestId);
    if (
      (previous || retired) &&
      (previous?.fingerprint || retired) !== fingerprint
    )
      throw new Error(
        'Dubbing operation identifier conflicts with another request',
      );
    if (previous?.interrupted)
      throw new Error(
        'Dubbing operation was interrupted; inspect saved results before starting a new request',
      );
    if (previous)
      return previous.promise.then((result) => structuredClone(result));
    if (retired)
      throw new Error(
        'Dubbing operation result expired; inspect the project before retrying',
      );
    const receipt: DubbingOperationReceipt<T> = {
      version: 1,
      sessionId,
      requestId,
      fingerprint,
      channel,
      createdAt: Math.max(
        Date.now(),
        ...Array.from(records.values(), (entry) => entry.receipt.createdAt + 1),
      ),
      status: 'pending',
    };
    this.storage?.write(receipt);
    const record: Operation<T> = {
      fingerprint,
      receipt,
      complete: false,
      promise: Promise.resolve()
        .then(execute)
        .then((result) => {
          record.result = structuredClone(result);
          record.complete = true;
          record.receipt = {
            ...record.receipt,
            status: 'complete',
            result: record.result,
          };
          // A successful export has already cleaned its private directory.
          if (
            record.receipt.channel === 'dubbing:export' &&
            (result as { success?: boolean })?.success
          )
            delete record.receipt.publication;
          try {
            this.storage?.write(record.receipt);
          } catch (error) {
            // Keep the actual outcome queryable; never repeat a committed operation.
            record.persistenceError = String(error);
          }
          const completed = Array.from(records.entries()).filter(
            ([, entry]) => entry.complete,
          );
          for (const [id, entry] of completed.slice(
            0,
            Math.max(0, completed.length - this.retainedResults),
          )) {
            try {
              this.storage?.write({
                ...entry.receipt,
                status: 'expired',
                result: undefined,
              });
            } catch {
              continue;
            }
            const tombstones = this.retired.get(sessionId) || new Map();
            tombstones.set(id, entry.fingerprint);
            this.retired.set(sessionId, tombstones);
            records.delete(id);
          }
          return record.result;
        }),
    };
    records.set(requestId, record);
    return record.promise.then((result) => structuredClone(result));
  }

  status(sessionId: string, requestId: string): DubbingOperationStatus<T> {
    this.load(sessionId);
    const record = this.sessions.get(sessionId)?.get(requestId);
    if (!record)
      return {
        status: this.retired.get(sessionId)?.has(requestId)
          ? 'expired'
          : 'missing',
      };
    if (record.interrupted) return { status: 'interrupted' };
    if (record.persistenceError) {
      try {
        this.storage?.write(record.receipt);
        record.persistenceError = undefined;
      } catch (error) {
        record.persistenceError = String(error);
      }
    }
    return record.complete
      ? {
          status: 'complete',
          result: structuredClone(record.result),
          ...(record.persistenceError
            ? { persistenceError: record.persistenceError }
            : {}),
        }
      : { status: 'pending' };
  }
}
