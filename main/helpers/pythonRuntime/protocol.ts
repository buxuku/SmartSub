export interface EngineRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineErrorPayload {
  code: string;
  message: string;
}

export interface EngineResponse {
  id: string;
  result?: unknown;
  error?: EngineErrorPayload;
}

export type EngineMessage = EngineResponse | EngineNotification;

export interface PingResult {
  version: string;
  python: string;
  frozen: boolean;
  engines: Record<string, boolean>;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; word: string }>;
}

export interface TranscribeResult {
  engine: string;
  language?: string;
  languageProbability?: number;
  duration?: number;
  segments: TranscribeSegment[];
}

export interface TranscribeHandlers {
  onProgress?: (percent: number) => void;
  onSegment?: (segment: TranscribeSegment) => void;
}
