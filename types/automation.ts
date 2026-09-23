export interface ArtifactRef {
  kind: string;
  path: string;
}
export type AutomationStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'review'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface AutomationError {
  code: string;
  message: string;
  details?: unknown;
}
export interface AutomationJob {
  id: string;
  operation: string;
  status: AutomationStatus;
  createdAt: number;
  updatedAt: number;
  requestId?: string;
  fingerprint?: string;
  projectId?: string;
  progress?: unknown;
  result?: unknown;
  error?: AutomationError;
  artifacts: ArtifactRef[];
  actions: string[];
}
export interface AutomationContext {
  jobId?: string;
  event: any;
  signal: AbortSignal;
  setCancel(cancel: () => void | Promise<void>): void;
  trackModelProgress?(key: string): void;
}
