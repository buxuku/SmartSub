import type { AutomationJob } from './automation';

export type AssistantEditableField = 'sourceContent' | 'targetContent';

export interface AssistantAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  kind: 'image' | 'audio' | 'video' | 'file';
  imagePath?: string;
  mimeType?: string;
}
export const ASSISTANT_MAX_ATTACHMENTS = 8;

export interface AssistantContextSnapshot {
  page: string;
  capturedAt: number;
  projectId?: string;
  sessionId?: string;
  files?: string[];
  task?: Record<string, unknown>;
  recentErrors?: string[];
  editor?: {
    documentId: string;
    revision: string;
    files: string[];
    dirty: boolean;
    selectedIndex: number;
    currentTime: number;
    total: number;
    sourceLanguage?: string;
    targetLanguage?: string;
    editableFields: AssistantEditableField[];
    cues: AssistantCue[];
  };
}

export interface AssistantCue {
  index: number;
  sourceContent: string;
  targetContent: string;
  start?: number;
  end?: number;
}

export interface EditorCommand {
  id: string;
  kind: 'read' | 'edit' | 'locate' | 'save';
  documentId: string;
  expectedRevision: string;
  offset?: number;
  limit?: number;
  index?: number;
  edits?: Array<{
    index: number;
    field: AssistantEditableField;
    text: string;
  }>;
}

export interface EditorCommandResult {
  context: AssistantContextSnapshot;
  cues?: AssistantCue[];
  changed?: number;
  saved?: boolean;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: unknown;
  job?: AutomationJob;
}

export interface AssistantMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  context?: AssistantContextSnapshot;
  attachments?: AssistantAttachment[];
  tools?: AssistantToolCall[];
}

export interface AssistantSession {
  id: string;
  title: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
  status: 'idle' | 'running' | 'interrupted' | 'failed' | 'limited';
  error?: string;
  messages: AssistantMessage[];
}

export interface AssistantProvider {
  id: string;
  name: string;
  modelName: string;
}

export type AssistantRunEvent =
  | { type: 'session'; session: AssistantSession }
  | { type: 'delta'; sessionId: string; messageId: string; text: string }
  | { type: 'changed'; operation: string };

export const ASSISTANT_PROVIDER_TYPES = new Set([
  'openai',
  'deepseek',
  'DeerAPI',
  'Gemini',
  'siliconflow',
  'qwen',
]);
