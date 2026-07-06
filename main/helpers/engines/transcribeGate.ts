import type { TranscriptionEngine } from '../../../types/engine';
import { TaskCancelledError } from '../taskContext';

/**
 * 转写阶段互斥闸（阶段流水线的核心）。
 *
 * 背景：faster-whisper 共享单 Python sidecar，funasr/qwen/fireRedAsr 共享单 sherpa
 * worker（单例 recognizer/VAD，两个转写交错会互相污染状态），这些引擎的「转写阶段」
 * 必须串行。旧实现是在调度器把整个任务队列的有效并发钳为 1——代价是排队文件的
 * 音频提取、翻译等本可并行的阶段也被迫干等。
 *
 * 现改为：任务照常按 maxConcurrentTasks 并发派发，仅在进入转写阶段时按「执行体组」
 * 排队（FIFO）。同组内同一时刻只有一个转写在跑；提取/翻译与他人的转写自然重叠。
 * builtin/localCli/cloud 无共享执行体，不参与排队。
 *
 * 注：sidecar 与 sherpa worker 是两个独立执行体，faster-whisper 与 funasr 系任务
 * 可以互相并行，故分两组而非一把全局锁。
 */
type ExecutorGroup = 'pySidecar' | 'sherpaWorker';

function executorGroupOf(engine: TranscriptionEngine): ExecutorGroup | null {
  if (engine === 'fasterWhisper') return 'pySidecar';
  if (engine === 'funasr' || engine === 'qwen' || engine === 'fireRedAsr') {
    return 'sherpaWorker';
  }
  return null;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class GroupMutex {
  private locked = false;
  private waiters: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new TaskCancelledError());
    }
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.buildRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => resolve(this.buildRelease()),
        reject,
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new TaskCancelledError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private buildRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        // 锁保持 locked=true，直接移交给下一个等待者
        next.resolve();
      } else {
        this.locked = false;
      }
    };
  }
}

const groupMutexes = new Map<ExecutorGroup, GroupMutex>();

function mutexOf(group: ExecutorGroup): GroupMutex {
  let mutex = groupMutexes.get(group);
  if (!mutex) {
    mutex = new GroupMutex();
    groupMutexes.set(group, mutex);
  }
  return mutex;
}

const NOOP_RELEASE = () => {};

/**
 * 进入转写阶段前获取执行槽。受限引擎按组排队（等待可被 AbortSignal 取消，
 * 抛 TaskCancelledError），其余引擎立即放行。返回 release，必须在转写结束后调用。
 */
export function acquireTranscribeSlot(
  engine: TranscriptionEngine,
  signal?: AbortSignal,
): Promise<() => void> {
  const group = executorGroupOf(engine);
  if (!group) return Promise.resolve(NOOP_RELEASE);
  return mutexOf(group).acquire(signal);
}
