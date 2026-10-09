/**
 * 共用的 utilityProcess 宿主底座：统一 fork、stderr、退出分类与崩溃记录。
 *
 * TTS、sherpa ASR、说话人分离三个宿主原本各写了一遍相同的 fork / stderr / exit 样板，
 * 而且都没有利用退出码做分类。这里只收拢样板，不改变各宿主的消息协议、池大小与生命周期：
 * 宿主仍然自己决定“退出后拒绝哪些在途请求、用什么文案”。
 *
 * 底座额外做的三件事：
 * 1. 记录 stderr 尾部。onnxruntime / sherpa 的报错在原生崩溃前几毫秒才写出，是最关键的线索；
 *    异常退出时连同分类一起写进 crash-events.jsonl（child-process-gone 事件里没有这部分）。
 * 2. 主动终止（kill）先打标记并登记。实测 Electron 对主动 kill 同样会触发 child-process-gone，
 *    不登记的话每次回收 worker 都会冒出一条“被杀”事件。
 * 3. Linux 上让崩溃的子进程尽快退出。默认的管道式 core_pattern（systemd-coredump / apport）
 *    会让崩溃的进程等 core 写完才退出，worker 崩了而主进程误以为任务仍在跑。两层办法：
 *    - 先同步写 /proc/<pid>/coredump_filter = 0：没有进程启动延迟，core 只剩十几 KB。
 *      GitHub ubuntu-24.04 实测崩溃后约 130 ms 退出；
 *    - 再异步执行 `prlimit --pid <pid> --core=1:`：RLIMIT_CORE=1 让内核直接放弃把 core 交给
 *      管道程序，实测约 65 ms 退出。但 prlimit 要起一个外部进程，机器忙时会晚于崩得快的 worker
 *      （CI 里机器被前面几个还在写 core 的崩溃进程拖慢时，出现过 60 秒不退出，当时限制要到
 *      worker 启动后约 150 ms 才取得到，推断是输给了崩溃），所以它只是第二层。
 *    两种办法都不影响 Crashpad 转储（它自己读进程内存）。两种都不可用时只记一次日志（该情形未验证）。
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { UtilityProcess } from 'electron';
import {
  classifyExit,
  describeExit,
  type ExitClassification,
} from './exitClassifier';

export type HostLogLevel = 'info' | 'warning' | 'error';

const STDERR_TAIL_CHARS = 8 * 1024;

/** 子进程退出时交给宿主回调的信息。 */
export interface HostExitInfo {
  code: number;
  /** 由 host.kill() 主动终止；此时的非零退出码是信号终止的垃圾值，不是故障 */
  killedByUs: boolean;
  classification: ExitClassification;
  stderrTail: string;
}

/** 写入 crash-events.jsonl 的一条宿主退出记录。 */
export interface UtilityExitRecord {
  name: string;
  exitCode?: number;
  classification: ExitClassification;
  stderrTail?: string;
}

export interface HostDeps {
  fork: (
    file: string,
    args: string[],
    options: Electron.ForkOptions,
  ) => UtilityProcess;
  platform: NodeJS.Platform;
  /** 同步把系统 core 的内容缩到最小（coredump_filter = 0）；返回错误文本，成功返回 null */
  shrinkCoreDump: (pid: number) => string | null;
  /** 给 pid 设置 core 软限制；返回错误文本，成功返回 null */
  limitCore: (pid: number) => Promise<string | null>;
}

export interface SpawnHostOptions {
  workerFile: string;
  /** 传给 utilityProcess 的 serviceName，出现在 child-process-gone 的 name 字段 */
  serviceName: string;
  /** 日志前缀，保持各宿主原有的日志文案，例如 'tts worker' */
  logLabel: string;
  env: NodeJS.ProcessEnv;
  log: (message: string, level: HostLogLevel) => void;
  /** 异常退出时记入 crash-events（含 stderr 尾部）；缺省不记 */
  recordExit?: (record: UtilityExitRecord) => void;
  /** 主动终止前登记，使随后的“被杀”事件不被当作异常 */
  expectKill?: (serviceName: string) => void;
  deps?: Partial<HostDeps>;
}

/** 与原先三处完全相同的 sherpa worker 环境：原生库目录进入 PATH / LD_LIBRARY_PATH。 */
export function buildSherpaWorkerEnv(
  libDir: string,
  base: NodeJS.ProcessEnv = process.env,
  delimiter: string = path.delimiter,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SHERPA_ONNX_LIB_DIR: libDir,
    // Windows DLL / Linux SO 依赖解析（macOS 靠 @loader_path 重写）。
    PATH: `${libDir}${delimiter}${base.PATH ?? ''}`,
    LD_LIBRARY_PATH: `${libDir}${delimiter}${base.LD_LIBRARY_PATH ?? ''}`,
  };
}

/** 导出仅为单测：默认实现，写 /proc/<pid>/coredump_filter。 */
export function shrinkCoreDumpViaProc(pid: number): string | null {
  try {
    fs.writeFileSync(`/proc/${pid}/coredump_filter`, '0');
    return null;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code ||
      (error instanceof Error ? error.message.split('\n')[0] : '') ||
      'write failed'
    );
  }
}

function limitCoreWithPrlimit(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'prlimit',
      ['--pid', String(pid), '--core=1:'],
      { timeout: 3000 },
      (error) => {
        resolve(
          error
            ? String(error.message).split('\n')[0] || 'prlimit failed'
            : null,
        );
      },
    );
  });
}

function defaultDeps(): HostDeps {
  return {
    // 延迟加载 electron：纯 Node 环境下的单测不需要（也可能没有）Electron 二进制
    fork: (file, args, options) =>
      (require('electron') as typeof import('electron')).utilityProcess.fork(
        file,
        args,
        options,
      ),
    platform: process.platform,
    shrinkCoreDump: shrinkCoreDumpViaProc,
    limitCore: limitCoreWithPrlimit,
  };
}

let coreLimitWarned = false;

/** 仅供测试：重置“只提示一次”的状态。 */
export function resetUtilityHostStateForTest(): void {
  coreLimitWarned = false;
}

export class UtilityHost {
  private readonly options: SpawnHostOptions;
  private readonly proc: UtilityProcess;
  private killedByUs = false;
  private stderrTail = '';
  private exitListeners: Array<(info: HostExitInfo) => void> = [];

  constructor(options: SpawnHostOptions) {
    this.options = options;
    const deps: HostDeps = { ...defaultDeps(), ...options.deps };
    this.proc = deps.fork(options.workerFile, [], {
      serviceName: options.serviceName,
      stdio: 'pipe',
      env: options.env,
    });

    if (deps.platform === 'linux') {
      this.proc.on('spawn', () => {
        const pid = this.proc.pid;
        if (pid === undefined) return;
        // 先做同步的那一步：它赶得上崩得最快的 worker；prlimit 要起外部进程，只能作为第二层
        let filterError: string | null;
        try {
          filterError = deps.shrinkCoreDump(pid);
        } catch (error) {
          filterError = error instanceof Error ? error.message : String(error);
        }
        void deps.limitCore(pid).then((limitError) => {
          // 两层里有一层生效就不提示
          if (!limitError || !filterError || coreLimitWarned) return;
          coreLimitWarned = true;
          options.log(
            `${options.logLabel}: could not lower RLIMIT_CORE (${limitError}) or coredump_filter (${filterError}); on systems that pipe core dumps a crashed worker may take a long time to exit`,
            'warning',
          );
        });
      });
    }

    // native 崩溃前的 stderr 是关键诊断线索（onnxruntime/sherpa 报错都走这里）。
    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = String(data);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      const line = text.trim();
      if (line) options.log(`${options.logLabel} stderr: ${line}`, 'warning');
    });

    this.proc.on('exit', (code) => {
      const classification = classifyExit({
        platform: deps.platform,
        exitCode: code,
        killedByUs: this.killedByUs,
      });
      const info: HostExitInfo = {
        code,
        killedByUs: this.killedByUs,
        classification,
        stderrTail: this.stderrTail,
      };
      // 先落盘再通知宿主：宿主的回调会拒绝在途请求，调用方随后可能立刻退出应用
      if (classification.abnormal) {
        try {
          options.recordExit?.({
            name: options.serviceName,
            exitCode: code,
            classification,
            stderrTail: this.stderrTail,
          });
        } catch {
          // 记录失败不能影响宿主自己的退出处理
        }
      }
      for (const listener of this.exitListeners) listener(info);
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  onMessage(listener: (message: any) => void): void {
    this.proc.on('message', listener);
  }

  /** 子进程退出（含崩溃与主动终止）时回调一次。 */
  onExit(listener: (info: HostExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  postMessage(message: unknown): void {
    this.proc.postMessage(message);
  }

  /** 主动终止：先打标记并登记，再 kill。 */
  kill(): void {
    this.killedByUs = true;
    try {
      this.options.expectKill?.(this.options.serviceName);
    } catch {
      // 登记失败只会多一条“被杀”事件
    }
    try {
      this.proc.kill();
    } catch {
      // 进程可能已经退出
    }
  }
}

export function spawnUtilityHost(options: SpawnHostOptions): UtilityHost {
  return new UtilityHost(options);
}

/** 宿主异常退出时的日志文案：用分类后的描述代替裸退出码，原有的 code 仍保留。 */
export function describeHostExit(info: HostExitInfo): string {
  return `${describeExit(info.classification)}, code ${info.code}`;
}
