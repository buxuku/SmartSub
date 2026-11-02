import type { HostExitInfo } from './utilityHost';
import type {
  WhisperProbeRequest,
  WhisperProbeResult,
} from '../../../types/whisperProbe';

export interface ProbeHost {
  onMessage(listener: (message: any) => void): void;
  onExit(listener: (info: HostExitInfo) => void): void;
  postMessage(message: unknown): void;
  kill(): void;
}

interface ProbeOptions {
  request: WhisperProbeRequest;
  addonPath: string;
  addonSource: string;
  params: Record<string, unknown>;
  spawn(onStderrLine: (line: string) => void): ProbeHost;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Sanitize before persisting native paths/errors, not just on export. */
  clean: (text: string) => string;
}

/** One disposable process per test. Never load the diagnostic addon in the main process. */
export function runWhisperProbe(
  options: ProbeOptions,
): Promise<WhisperProbeResult> {
  const startedAt = Date.now();
  const result: WhisperProbeResult = {
    ...options.request,
    startedAt,
    durationMs: 0,
    addonPath: options.clean(options.addonPath),
    addonSource: options.addonSource,
    flashAttn: false,
    input: 'bundled-sample',
    status: 'error',
    phase: 'starting',
    nativeDeviceLines: [],
    stderrTail: '',
  };
  return new Promise((resolve) => {
    let host: ProbeHost | undefined;
    let settled = false;
    let receivedResult = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      result.durationMs = Date.now() - startedAt;
      resolve(result);
    };
    const stop = (status: 'timeout' | 'cancelled' | 'error') => {
      if (settled) return;
      result.status = status;
      // Some hosts deliver exit synchronously from kill; the explicit outcome wins.
      finish();
      host?.kill();
    };
    const cancel = () => stop('cancelled');
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      host = options.spawn((rawLine) => {
        if (settled) return;
        const line = options.clean(rawLine);
        result.stderrTail = (result.stderrTail + line + '\n').slice(-16 * 1024);
        if (
          /ggml_vulkan:|whisper_backend_init_gpu:|register_device:|gpu_device\s*=/.test(
            line,
          )
        ) {
          // Keep enumeration and selection even when later progress pushes them out of the tail.
          if (result.nativeDeviceLines.length < 80)
            result.nativeDeviceLines.push(line.slice(0, 2048));
        }
      });
      host.onMessage((message) => {
        if (settled) return;
        if (message?.type === 'phase' && typeof message.phase === 'string') {
          result.phase = message.phase.slice(0, 100);
        } else if (message?.type === 'result' && !receivedResult) {
          receivedResult = true;
          result.status = message.ok === true ? 'completed' : 'error';
          if (typeof message.error === 'string')
            result.error = options.clean(message.error).slice(0, 4096);
          if (Number.isSafeInteger(message.segments) && message.segments >= 0)
            result.segments = message.segments;
          // Wait for exit to include trailing native stderr and catch teardown crashes.
          try {
            host!.postMessage({ type: 'shutdown' });
          } catch (error) {
            result.error = options.clean(String(error));
            stop('error');
          }
        }
      });
      host.onExit((info) => {
        if (settled) return;
        result.exit = {
          code: info.code,
          kind: info.classification.kind,
          label: info.classification.label,
          ...(info.classification.realCodeLost ? { realCodeLost: true } : {}),
        };
        if (info.classification.abnormal || !receivedResult)
          result.status = 'exited';
        finish();
      });
      timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 180_000);
      host.postMessage({
        type: 'run',
        addonPath: options.addonPath,
        params: options.params,
      });
    } catch (error) {
      result.error = options.clean(
        error instanceof Error ? error.message : String(error),
      );
      stop('error');
    }
  });
}
