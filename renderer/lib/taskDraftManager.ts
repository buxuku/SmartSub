export interface TaskDraft {
  id?: string;
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
  savedAt: number;
}

export const TASK_WIZARD_DRAFT_KEY = 'smartsub_task_wizard_draft_v1';

export class TaskDraftManager {
  private memoryDraft: TaskDraft | null = null;

  serializeDraft(draft: TaskDraft): string {
    return JSON.stringify(draft);
  }

  deserializeDraft(raw: string): TaskDraft | null {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.files)) {
        return parsed as TaskDraft;
      }
      return null;
    } catch {
      return null;
    }
  }

  patchDraft(partial: Partial<TaskDraft>): void {
    const existing = this.getDraft() || { files: [], savedAt: Date.now() };
    const merged: TaskDraft = {
      ...existing,
      ...partial,
      savedAt: Date.now(),
    };
    this.saveDraft(merged);
  }

  saveDraft(draft: TaskDraft): void {
    this.memoryDraft = draft;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        if (draft.files && draft.files.length > 0) {
          window.localStorage.setItem(
            TASK_WIZARD_DRAFT_KEY,
            this.serializeDraft(draft),
          );
        } else {
          this.clearDraft();
        }
      } catch (e) {
        console.error('Failed to save task draft:', e);
      }
    }
  }

  getDraft(): TaskDraft | null {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(TASK_WIZARD_DRAFT_KEY);
        if (raw) {
          const draft = this.deserializeDraft(raw);
          if (draft) {
            this.memoryDraft = draft;
            return draft;
          }
        }
      } catch (e) {
        console.error('Failed to read task draft:', e);
      }
    }
    return this.memoryDraft;
  }

  clearDraft(): void {
    this.memoryDraft = null;
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(TASK_WIZARD_DRAFT_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  hasDraft(): boolean {
    const draft = this.getDraft();
    return Boolean(draft && draft.files && draft.files.length > 0);
  }
}

export const taskDraftManager = new TaskDraftManager();
