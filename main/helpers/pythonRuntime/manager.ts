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
import { isProtocolSupported } from './protocolSupport';

export interface EngineCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 基座 prefix（设为 PYTHONHOME，定位 stdlib） */
  pythonHome?: string;
  /** 引擎包 site-packages（设为 PYTHONPATH，挂载该引擎依赖） */
  pythonPath?: string;
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
  onEvent?: (method: string, params: Record<string, unknown>) => void;
  timer?: NodeJS.Timeout;
}

interface RequestOptions {
  timeoutMs?: number;
  onEvent?: (method: string, params: Record<string, unknown>) => void;
}

// 冷启动 ping 超时：Windows 下基座解释器首次加载 + 杀软扫描可能较久。
// 重依赖已推迟到首个 transcribe（见 py-engine list_engines/find_spec），ping 本身很快，
// 这里给足冗余并配合一次重试，彻底消除"偶发冷启动超时"。
export const START_PING_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 3_000;

export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides?: { pythonHome?: string; pythonPath?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
  // 先清宿主机污染源（全局 conda/venv/PYTHONPATH 会污染基座解释器）
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.VIRTUAL_ENV;
  delete env.CONDA_PREFIX;
  // 再按三层模型注入受控值：基座 prefix + 当前引擎包 site-packages
  if (overrides?.pythonHome) env.PYTHONHOME = overrides.pythonHome;
  if (overrides?.pythonPath) env.PYTHONPATH = overrides.pythonPath;
  return env;
}

export class PythonRuntimeManager {
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
    // 防重入：若残留旧进程（如上次 ping 超时未清理），先杀掉，避免孤儿 + 引用覆盖。
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // already exited
      }
      this.proc = null;
    }

    const attempt = async (): Promise<PingResult> => {
      const cmd = this.resolveCommand();
      this.logger(
        `Starting python engine: ${cmd.command} ${cmd.args.join(' ')}`,
        'info',
      );

      const proc = spawn(cmd.command, cmd.args, {
        cwd: cmd.cwd,
        env: {
          ...buildSanitizedEnv(process.env, {
            pythonHome: cmd.pythonHome,
            pythonPath: cmd.pythonPath,
          }),
          ...(cmd.env || {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = proc;

      proc.on('error', (error) => {
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

      try {
        const info = await this.request<PingResult>(
          'ping',
          {},
          {
            timeoutMs: START_PING_TIMEOUT_MS,
          },
        );

        // 协议区间校验：超出 app 支持区间则停机并报错（提示升级 SmartSub，而非崩溃）。
        // 旧引擎不返回 protocolVersion 时放行（向后兼容）。
        if (
          typeof info.protocolVersion === 'number' &&
          !isProtocolSupported(info.protocolVersion)
        ) {
          if (this.proc === proc) {
            try {
              proc.kill();
            } catch {
              // already exited
            }
            this.proc = null;
            this.lastPingInfo = null;
          }
          throw new PythonEngineError(
            'protocol_unsupported',
            `engine protocolVersion=${info.protocolVersion} not supported by this SmartSub`,
          );
        }

        this.lastPingInfo = info;
        this.logger(
          `Python engine ready: version=${info.version} python=${info.python} engines=${JSON.stringify(info.engines)}`,
          'info',
        );
        return info;
      } catch (error) {
        // 关键：ping 失败（超时/退出）时务必杀掉仍在启动的进程，
        // 避免孤儿 + 二次 spawn + Windows 文件锁。
        if (this.proc === proc) {
          try {
            proc.kill();
          } catch {
            // already exited
          }
          this.proc = null;
          this.lastPingInfo = null;
        }
        throw error;
      }
    };

    try {
      return await attempt();
    } catch (firstError) {
      // 协议不兼容重试无意义，直接抛出。
      if (
        firstError instanceof PythonEngineError &&
        firstError.code === 'protocol_unsupported'
      ) {
        throw firstError;
      }
      this.logger(
        `Python engine start failed, retrying once: ${firstError}`,
        'warning',
      );
      return attempt();
    }
  }

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

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    this.write({ method, params });
  }

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

  cancel(id: string): void {
    this.notify('cancel', { id });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    try {
      this.notify('shutdown', {});
      proc.stdin.end();
    } catch {
      // process may have already exited
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already exited
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

    const notification = message as {
      method: string;
      params?: Record<string, unknown>;
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
