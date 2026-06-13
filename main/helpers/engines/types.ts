import type { TranscriptionEngine, EngineStatus } from '../../../types/engine';
import type { IpcMainInvokeEvent } from 'electron';
import type { IFiles } from '../../../types';

export interface TranscribeContext {
  event: IpcMainInvokeEvent;
  file: IFiles;
  formData: Record<string, unknown>;
  hasOpenAiWhisper: boolean;
}

export interface TranscriptionEngineAdapter {
  id: TranscriptionEngine;
  displayName: string;
  requiresRuntime: boolean;
  isAvailable(): Promise<EngineStatus>;
  transcribe(ctx: TranscribeContext): Promise<string>;
  cancelActive?(): void;
}
