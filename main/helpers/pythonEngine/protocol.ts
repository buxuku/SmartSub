/**
 * Python 引擎 sidecar 的 stdio JSON-lines 协议类型定义。
 * 与 python-engine/main.py 中的消息结构一一对应。
 */

/** Electron -> Python 请求(期待应答) */
export interface EngineRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** 双向通知(无 id,不期待应答),如 cancel / shutdown / progress / segment */
export interface EngineNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineErrorPayload {
  code: string;
  message: string;
}

/** Python -> Electron 响应 */
export interface EngineResponse {
  id: string;
  result?: unknown;
  error?: EngineErrorPayload;
}

export type EngineMessage = EngineResponse | EngineNotification;

/** ping 方法的返回值 */
export interface PingResult {
  version: string;
  python: string;
  frozen: boolean;
  engines: Record<string, boolean>;
}

export interface TranscribeWord {
  start: number;
  end: number;
  word: string;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscribeWord[];
}

export interface TranscribeResult {
  engine: string;
  language?: string;
  languageProbability?: number;
  duration?: number;
  segments: TranscribeSegment[];
}

/** transcribe 过程中的事件回调 */
export interface TranscribeHandlers {
  onProgress?: (percent: number) => void;
  onSegment?: (segment: TranscribeSegment) => void;
}
