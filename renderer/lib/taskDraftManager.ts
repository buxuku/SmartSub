import type { PendingTaskSubmission } from '../../types/taskSubmission';
import { z } from 'zod';

export interface TaskDraft {
  id?: string;
  submission?: PendingTaskSubmission;
  files: any[];
  goals?: {
    translate?: boolean;
    dub?: boolean;
    video?: boolean;
  };
  manualPairs?: [string, string][];
  manualManuscriptPairs?: [string, string][];
  taskType?: string;
  config?: Record<string, any>;
  pipeline?: {
    dubbing: Record<string, any>;
    subtitle: 'hard' | 'soft' | 'none';
    styleId: string;
    quality: string;
    encoder: string;
    subtitleGate: boolean;
    dubbingGate: boolean;
    recipeName: string | null;
  };
  savedAt: number;
}

export const TASK_WIZARD_DRAFT_KEY = 'smartsub_task_wizard_draft_v1';

const pairs = z.array(z.tuple([z.string(), z.string()]));
const draftSchema = z.object({
  id: z.string().optional(),
  submission: z
    .object({ key: z.string(), requestId: z.string().min(1) })
    .optional(),
  files: z.array(
    z
      .object({ filePath: z.string().min(1), fileName: z.string() })
      .passthrough(),
  ),
  goals: z
    .object({
      translate: z.boolean().optional(),
      dub: z.boolean().optional(),
      video: z.boolean().optional(),
    })
    .optional(),
  manualPairs: pairs.optional(),
  manualManuscriptPairs: pairs.optional(),
  taskType: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  pipeline: z
    .object({
      dubbing: z
        .object({
          engineKey: z.string().optional(),
          voice: z.string().optional(),
          language: z.string().optional(),
          globalSpeed: z.number().finite().positive().optional(),
          cloneQuality: z.enum(['standard', 'high']).optional(),
          localConcurrency: z.number().int().positive().optional(),
        })
        .passthrough(),
      subtitle: z.enum(['hard', 'soft', 'none']),
      styleId: z.string(),
      quality: z.enum(['original', 'high', 'standard']),
      encoder: z.enum(['cpu', 'hardware']),
      subtitleGate: z.boolean(),
      dubbingGate: z.boolean(),
      recipeName: z.string().nullable(),
    })
    .optional(),
  savedAt: z.number().finite().nonnegative(),
});

export class TaskDraftManager {
  private memoryDraft: TaskDraft | null = null;
  private memoryLoaded = false;
  private readFailed = false;
  storageFailed = false;

  get hasUnreadableDraft(): boolean {
    return this.readFailed;
  }

  serializeDraft(draft: TaskDraft): string {
    return JSON.stringify(draft);
  }

  deserializeDraft(raw: string): TaskDraft | null {
    try {
      const parsed = draftSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as TaskDraft) : null;
    } catch {
      return null;
    }
  }

  patchDraft(partial: Partial<TaskDraft>): boolean {
    const existing = this.getDraft() || { files: [], savedAt: Date.now() };
    const merged: TaskDraft = {
      ...existing,
      ...partial,
      savedAt: Date.now(),
    };
    return this.saveDraft(merged);
  }

  saveDraft(draft: TaskDraft): boolean {
    if (!this.memoryLoaded) this.getDraft();
    // Failed reads are not proof that no draft exists. Keep the original bytes
    // until a successful read or an explicit discard, including empty autosaves.
    if (this.readFailed) return false;
    if (!draft.files?.length) {
      return this.clearDraft();
    }
    this.memoryDraft = structuredClone(draft);
    this.memoryLoaded = true;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          TASK_WIZARD_DRAFT_KEY,
          this.serializeDraft(draft),
        );
        this.storageFailed = false;
        return true;
      } catch (e) {
        console.error('Failed to save task draft:', e);
      }
    }
    this.storageFailed = true;
    return false;
  }

  getDraft(): TaskDraft | null {
    if (this.memoryLoaded)
      return this.memoryDraft ? structuredClone(this.memoryDraft) : null;
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(TASK_WIZARD_DRAFT_KEY);
        if (raw) {
          const draft = this.deserializeDraft(raw);
          if (draft) {
            this.memoryDraft = draft;
            this.memoryLoaded = true;
            this.readFailed = false;
            this.storageFailed = false;
            return structuredClone(draft);
          }
          this.readFailed = true;
          this.storageFailed = true;
          return null;
        }
        this.memoryLoaded = true;
        this.readFailed = false;
        this.storageFailed = false;
      } catch (e) {
        console.error('Failed to read task draft:', e);
        this.storageFailed = true;
        this.readFailed = true;
      }
    }
    return this.memoryDraft ? structuredClone(this.memoryDraft) : null;
  }

  clearDraft(): boolean {
    this.memoryDraft = null;
    this.readFailed = false;
    // A failed removal must not resurrect stale disk state within this session.
    this.memoryLoaded = true;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(TASK_WIZARD_DRAFT_KEY);
        this.storageFailed = false;
        return true;
      } catch {
        this.storageFailed = true;
        return false;
      }
    }
    return true;
  }

  hasDraft(): boolean {
    const draft = this.getDraft();
    return Boolean(draft && draft.files && draft.files.length > 0);
  }
}

export const taskDraftManager = new TaskDraftManager();
