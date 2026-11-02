/** Explicit diagnostic runs only; ordinary transcription is unchanged. */
export interface WhisperProbeRequest {
  model: string;
  backend: 'vulkan' | 'cpu';
  vad: boolean;
}

export interface WhisperProbeOptions {
  models: string[];
  defaultModel: string;
  backends: WhisperProbeRequest['backend'][];
  vad: boolean;
}

export interface WhisperProbeResult extends WhisperProbeRequest {
  startedAt: number;
  durationMs: number;
  addonPath: string;
  addonSource: string;
  flashAttn: false;
  input: 'bundled-sample';
  status: 'completed' | 'error' | 'exited' | 'timeout' | 'cancelled';
  phase: string;
  error?: string;
  segments?: number;
  exit?: {
    code: number;
    kind: string;
    label: string;
    realCodeLost?: boolean;
  };
  /** Actual native messages; OS adapter ordering is not a Vulkan device index. */
  nativeDeviceLines: string[];
  stderrTail: string;
}
