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
  engineVersion?: string;
  protocolVersion?: number;
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
  beforeReviewSegments?: TranscribeSegment[];
  reviewSpeechSegments?: Array<{ start: number; end: number }>;
  speechReview?: {
    status: 'complete' | 'unavailable';
    checked?: number;
    recovered?: number;
    retimed?: number;
    pending?: number;
    seconds?: number;
    changes?: Array<{
      start: number;
      end: number;
      original: string;
      text: string;
    }>;
    unresolved?: Array<{
      start: number;
      end: number;
      reason: string;
      suggestedText?: string;
      originalText?: string;
      issue?: 'timing' | 'text';
    }>;
  };
}

export interface TranscribeHandlers {
  onProgress?: (percent: number) => void;
  onSegment?: (segment: TranscribeSegment) => void;
  onReview?: (review: {
    stage: 'checking' | 'reviewing' | 'complete';
    completed: number;
    total: number;
  }) => void;
}
