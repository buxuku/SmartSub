import path from 'path';
import { randomUUID } from 'crypto';
import { getWorkItemById, saveWorkItem } from './workItemStore';
import type { WorkItem } from '../../types/workItem';
import type { ToolboxToolId } from '../../types/toolbox';

export function startProcessingHistory(input: {
  id?: string;
  type: 'compose' | 'toolbox';
  toolId?: ToolboxToolId;
  inputPaths: string[];
  config?: Record<string, unknown>;
  status?: 'waiting' | 'running';
}): string {
  const id = input.id || randomUUID();
  const now = Date.now();
  saveWorkItem(
    {
      id,
      name: path.basename(input.inputPaths[0] || input.toolId || 'Video'),
      type: input.type,
      status: input.status || 'running',
      createdAt: now,
      updatedAt: now,
      configSnapshot: input.config,
      processing: { inputPaths: input.inputPaths, toolId: input.toolId },
      artifacts: [],
    },
    { durable: true },
  );
  return id;
}

/** A completed output must stay usable even if persisting its history needs a retry. */
export function updateProcessingHistory(
  id: string,
  status: WorkItem['status'],
  outputPaths: string[] = [],
  error?: string,
): string | undefined {
  const item = getWorkItemById(id);
  if (!item) return;
  const next: WorkItem = {
    ...item,
    status,
    updatedAt: Date.now(),
    finishedAt: ['done', 'error', 'interrupted'].includes(status)
      ? Date.now()
      : undefined,
    processing: { ...item.processing!, error },
    artifacts: Array.from(new Set(outputPaths.filter(Boolean))).map(
      (filePath) => ({
        kind: path.extname(filePath).slice(1) || 'file',
        path: filePath,
      }),
    ),
  };
  try {
    saveWorkItem(next, { durable: true });
  } catch (cause) {
    saveWorkItem(next); // existing store retries pending writes
    console.error('[processingHistory] Persistence will retry:', cause);
    return cause instanceof Error ? cause.message : String(cause);
  }
}

export async function trackToolOperation<T>(
  toolId: ToolboxToolId,
  inputPaths: string[],
  config: Record<string, unknown>,
  run: () => Promise<T> | T,
): Promise<T> {
  const id = startProcessingHistory({
    type: 'toolbox',
    toolId,
    inputPaths,
    config,
  });
  try {
    const result = await run();
    const results = (Array.isArray(result) ? result : [result]) as Array<{
      success?: boolean;
      error?: string;
      outputPath?: string;
      outputPaths?: string[];
      extractedFiles?: Array<{ outputPath: string }>;
    }>;
    const outputs = results.flatMap((r) => [
      ...(r.success && r.outputPath ? [r.outputPath] : []),
      ...(r.outputPaths || []),
      ...(r.extractedFiles || []).map((file) => file.outputPath),
    ]);
    const failed = results.filter((r) => r.success !== true);
    updateProcessingHistory(
      id,
      failed.length ? 'error' : 'done',
      outputs,
      failed
        .map((r) => r.error)
        .filter(Boolean)
        .join('\n') || undefined,
    );
    return result;
  } catch (cause) {
    updateProcessingHistory(
      id,
      'error',
      [],
      cause instanceof Error ? cause.message : String(cause),
    );
    throw cause;
  }
}
