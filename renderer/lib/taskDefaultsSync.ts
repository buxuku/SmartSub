import { isEqual } from 'lodash';
import { isTaskDefaultsKey } from '../../types/taskConfig';
import { createDebouncedPersist } from './debouncedPersist';

/**
 * Remembering what the user adjusts on the task page as the defaults of the next new
 * task ("last used"), live. Pure logic with an injected `send`, so it is testable without
 * React or Electron; `useUnifiedTaskConfig` wires it to the form and to the IPC channel.
 *
 * Invariants:
 * - Only what the user changed is sent. Every loaded form is a session whose baseline is
 *   what the form held when it was loaded (defaults, an old project's draft, ...); a patch
 *   is the difference to that baseline, so an old project's stale values can never
 *   overwrite a default the user did not touch there, and merely opening one writes nothing.
 * - Automatic corrections are not user choices: `correct` moves the baseline only.
 * - A patch becomes part of the baseline only once the main process saved it, so a failed
 *   save is retried by the next one together with its newer keys, or by the next flush
 *   (leaving the page) when the user changed nothing since.
 * - Saves run one at a time: a change that was reverted while an earlier save was in
 *   flight is diffed against the baseline that save produced, so the last value wins.
 *
 * No module-level access to `window`: the hook module is also imported by node scripts.
 */

/** Same settle time as the other debounced settings editors. */
export const TASK_DEFAULTS_SYNC_DELAY_MS = 400;

type Values = Record<string, any>;

/** One hydration of the form. Saves keep working on the session they were made for. */
interface Session {
  baseline: Values;
  /** What the form held at the user's latest edit: the target of a retry. */
  latest?: Values;
  /** The latest save of this session failed, so the defaults may lag behind `latest`. */
  failed?: boolean;
}

/** Copy of `values` with `key` set, or removed when the value is `undefined`. */
function withKey(values: Values, key: string, value: unknown): Values {
  const next = { ...values };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * The reusable preferences whose value differs from the baseline; `undefined` marks a
 * removed key. Values are copied, so a form that keeps mutating cannot change a patch.
 */
export function diffTaskDefaults(baseline: Values, values: Values): Values {
  const patch: Values = {};
  const keys = Array.from(
    new Set([...Object.keys(baseline), ...Object.keys(values)]),
  );
  for (const key of keys) {
    if (!isTaskDefaultsKey(key) || isEqual(baseline[key], values[key]))
      continue;
    patch[key] = structuredClone(values[key]);
  }
  return patch;
}

export interface TaskDefaultsSyncOptions {
  /** Saves one patch in the main process. Must reject when it was not saved. */
  send: (patch: Values) => Promise<unknown>;
  delayMs?: number;
  /** Receives every failed save; the default logs it. */
  onError?: (error: unknown) => void;
}

export interface TaskDefaultsSync {
  /**
   * The form was loaded with `values`: they are what the defaults already hold or
   * deliberately ignore. Saves the previous session's pending edits first.
   */
  start(values: Values): void;
  /** The user changed the form, which now holds `values`. Saved after a short pause. */
  edit(values: Values): void;
  /** The code (not the user) changed one top-level value: never remembered. */
  correct(name: string, value: unknown): void;
  /**
   * Save pending edits now. The save is started synchronously when nothing else is in
   * flight; the promise settles once everything queued is saved or has failed.
   */
  flush(): Promise<void>;
}

export function createTaskDefaultsSync({
  send,
  delayMs = TASK_DEFAULTS_SYNC_DELAY_MS,
  onError = (error) => console.error('Failed to update task defaults:', error),
}: TaskDefaultsSyncOptions): TaskDefaultsSync {
  let session: Session | null = null;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();

  const run = async (target: Session, values: Values) => {
    try {
      const patch = diffTaskDefaults(target.baseline, values);
      if (Object.keys(patch).length > 0) {
        await send(patch);
        let baseline = target.baseline;
        for (const [key, value] of Object.entries(patch))
          baseline = withKey(baseline, key, value);
        target.baseline = baseline;
      }
      target.failed = false;
    } catch (error) {
      target.failed = true;
      onError(error);
    } finally {
      queued--;
    }
  };

  const enqueue = (target: Session, values: Values) => {
    queued++;
    // Idle: `run` starts here, so the request is out before the caller returns.
    const result =
      queued === 1 ? run(target, values) : tail.then(() => run(target, values));
    // A throwing `onError` must not break the chain for later saves.
    tail = result.catch(() => undefined);
  };

  let emitted = false;
  const writer = createDebouncedPersist<{ target: Session; values: Values }>(
    ({ target, values }) => {
      emitted = true;
      enqueue(target, values);
    },
    delayMs,
  );

  /** Send what is waiting now: the pending edit, else what a failed save left behind. */
  const flushPending = () => {
    emitted = false;
    writer.flush();
    if (emitted || !session?.failed || !session.latest) return;
    // Optimistic: a flush that follows while this retry is in flight must not queue
    // another one. `run` marks the session failed again if the retry fails too.
    session.failed = false;
    enqueue(session, session.latest);
  };

  return {
    start(values) {
      flushPending();
      session = { baseline: structuredClone(values) };
    },
    edit(values) {
      if (!session) return;
      session.latest = values;
      writer.schedule({ target: session, values });
    },
    correct(name, value) {
      if (session)
        session.baseline = withKey(
          session.baseline,
          name,
          structuredClone(value),
        );
    },
    flush() {
      flushPending();
      return tail;
    },
  };
}
