/**
 * Python 引擎 sidecar 进程管理器(PoC)。
 *
 * 职责:
 *  - spawn 常驻子进程(环境变量隔离,防系统 Python/conda 穿透)
 *  - stdio JSON-lines 协议的请求路由(id -> pending promise)
 *  - progress / segment 事件分发到对应请求的回调
 *  - 崩溃处理:reject 全部在途请求,惰性重启(下次 ensureStarted 时重新拉起)
 *
 * 不直接依赖 electron,命令解析与日志通过构造函数注入,便于脱离
 * Electron 环境做集成测试(见 index.ts 中的实际接线)。
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import {
  EngineMessage,
  EngineResponse,
  PingResult,
  TranscribeHandlers,
  TranscribeResult,
  TranscribeSegment,
} from './protocol';

export interface EngineCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export type EngineLogger = (
  message: string,
  level: 'info' | 'warning' | 'error',
) => void;

export class PythonEngineError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PythonEngineError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onEvent?: (method: string, params: Record<string, any>) => void;
  timer?: NodeJS.Timeout;
}

interface RequestOptions {
  timeoutMs?: number;
  onEvent?: (method: string, params: Record<string, any>) => void;
}

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * 构造隔离的子进程环境:即使应用自带运行时,也要防止用户系统的
 * Python/conda 配置通过环境变量穿透进来(最常见的诡异崩溃来源)。
 */
export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.VIRTUAL_ENV;
  delete env.CONDA_PREFIX;
  return env;
}

export class PythonEngineManager {
  private resolveCommand: () => EngineCommand;
  private logger: EngineLogger;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private startingPromise: Promise<PingResult> | null = null;
  private lastPingInfo: PingResult | null = null;
  private stopping = false;

  constructor(resolveCommand: () => EngineCommand, logger?: EngineLogger) {
    this.resolveCommand = resolveCommand;
    this.logger = logger || (() => {});
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  get engineInfo(): PingResult | null {
    return this.lastPingInfo;
  }

  /**
   * 确保引擎已启动并通过健康检查。幂等:已运行直接返回缓存信息,
   * 启动中复用同一个 promise。
   */
  async ensureStarted(): Promise<PingResult> {
    if (this.proc && this.lastPingInfo) {
      return this.lastPingInfo;
    }
    if (!this.startingPromise) {
      this.startingPromise = this.start().finally(() => {
        this.startingPromise = null;
      });
    }
    return this.startingPromise;
  }

  private async start(): Promise<PingResult> {
    const cmd = this.resolveCommand();
    this.logger(
      `Starting python engine: ${cmd.command} ${cmd.args.join(' ')}`,
      'info',
    );

    const proc = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: buildSanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    proc.on('error', (error) => {
      // spawn 本身失败(如命令不存在)也走统一的退出清理
      this.handleExit(`spawn error: ${error.message}`);
    });
    proc.on('exit', (code, signal) => {
      this.handleExit(`exited with code=${code} signal=${signal}`);
    });

    createInterface({ input: proc.stdout }).on('line', (line) => {
      this.handleLine(line);
    });
    createInterface({ input: proc.stderr }).on('line', (line) => {
      this.logger(line, 'info');
    });

    const info = await this.request<PingResult>(
      'ping',
      {},
      {
        timeoutMs: STARTUP_TIMEOUT_MS,
      },
    );
    this.lastPingInfo = info;
    this.logger(
      `Python engine ready: version=${info.version} python=${info.python} engines=${JSON.stringify(info.engines)}`,
      'info',
    );
    return info;
  }

  /** 发起请求并等待应答 */
  request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    const id = `${method}-${++this.seq}`;
    return this.requestWithId<T>(id, method, params, options);
  }

  private requestWithId<T>(
    id: string,
    method: string,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    if (!this.proc) {
      return Promise.reject(
        new PythonEngineError(
          'engine_not_running',
          'python engine is not running',
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        onEvent: options?.onEvent,
      };
      if (options?.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new PythonEngineError(
              'timeout',
              `${method} timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ id, method, params });
    });
  }

  /** 发送通知(不期待应答) */
  notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    this.write({ method, params });
  }

  /**
   * 发起转写。返回请求 id(用于 cancel)与结果 promise。
   * progress/segment 事件通过 handlers 回调,可直通现有 taskProgressChange 链路。
   */
  transcribe(
    params: Record<string, unknown>,
    handlers?: TranscribeHandlers,
  ): { id: string; result: Promise<TranscribeResult> } {
    const id = `transcribe-${++this.seq}`;
    const result = this.requestWithId<TranscribeResult>(
      id,
      'transcribe',
      params,
      {
        onEvent: (method, eventParams) => {
          if (method === 'progress' && handlers?.onProgress) {
            handlers.onProgress(Number(eventParams.percent) || 0);
          } else if (method === 'segment' && handlers?.onSegment) {
            handlers.onSegment(eventParams as unknown as TranscribeSegment);
          }
        },
      },
    );
    return { id, result };
  }

  /** 取消进行中的转写 */
  cancel(id: string): void {
    this.notify('cancel', { id });
  }

  /** 优雅停止:先发 shutdown,超时后强杀 */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    try {
      this.notify('shutdown', {});
      proc.stdin.end();
    } catch {
      // 进程可能已退出,忽略写入失败
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 已退出
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.stopping = false;
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    } catch (error) {
      this.logger(`Failed to write to python engine: ${error}`, 'error');
    }
  }

  private handleLine(line: string): void {
    let message: EngineMessage;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger(
        `Invalid JSON from python engine: ${line.slice(0, 200)}`,
        'warning',
      );
      return;
    }

    const response = message as EngineResponse;
    if (response.id !== undefined) {
      const entry = this.pending.get(response.id);
      if (!entry) {
        this.logger(`Response for unknown request: ${response.id}`, 'warning');
        return;
      }
      this.pending.delete(response.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (response.error) {
        entry.reject(
          new PythonEngineError(response.error.code, response.error.message),
        );
      } else {
        entry.resolve(response.result);
      }
      return;
    }

    // 事件通知:按 params.id 路由到对应请求的回调
    const notification = message as {
      method: string;
      params?: Record<string, any>;
    };
    const targetId = notification.params?.id;
    if (targetId) {
      const entry = this.pending.get(String(targetId));
      if (entry?.onEvent) {
        entry.onEvent(notification.method, notification.params || {});
        return;
      }
    }
    if (notification.method === 'log') {
      this.logger(`[py-engine] ${notification.params?.message}`, 'info');
    }
  }

  private handleExit(reason: string): void {
    if (!this.proc) return;
    this.proc = null;
    this.lastPingInfo = null;

    const level = this.stopping ? 'info' : 'error';
    this.logger(`Python engine ${reason}`, level);

    // 在途请求全部失败;下次 ensureStarted 会惰性重启
    const error = new PythonEngineError(
      'engine_exited',
      `python engine ${reason}`,
    );
    this.pending.forEach((entry) => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    });
    this.pending.clear();
  }
}
