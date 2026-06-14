import type { TranscriptionEngine, EngineStatus } from '../../../types/engine';
import type { IpcMainInvokeEvent } from 'electron';
import type { IFiles } from '../../../types';

export interface TranscribeContext {
  event: IpcMainInvokeEvent;
  file: IFiles;
  formData: Record<string, unknown>;
  hasOpenAiWhisper: boolean;
  /** 取消信号。由 router 从任务上下文注入，各引擎据此中断转写。 */
  signal?: AbortSignal;
}

export interface TranscriptionEngineAdapter {
  id: TranscriptionEngine;
  displayName: string;
  requiresRuntime: boolean;
  isAvailable(): Promise<EngineStatus>;
  transcribe(ctx: TranscribeContext): Promise<string>;
  /** 中断进行中的转写。builtin=signal 原生中断(no-op)、faster=sidecar 取消、localCli=kill child。 */
  cancelActive(): void;
}
