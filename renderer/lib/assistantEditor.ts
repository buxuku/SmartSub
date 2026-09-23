import type {
  AssistantContextSnapshot,
  AssistantCue,
  AssistantEditableField,
  EditorCommand,
  EditorCommandResult,
} from '../../types/assistant';
import type { Subtitle } from '../hooks/useSubtitles';

export interface AssistantEditorState {
  documentId: string;
  projectId?: string;
  files: string[];
  getSubtitles(): Subtitle[];
  getIsDirty(): boolean;
  selectedIndex: number;
  currentTime: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  editableFields: AssistantEditableField[];
  ready: boolean;
  updateSubtitles(cues: Subtitle[]): void;
  locate(index: number): void;
  save(): Promise<boolean>;
}
const cueData = (cue: Subtitle, index: number): AssistantCue => ({
  index,
  sourceContent: cue.sourceContent ?? cue.content.join('\n'),
  targetContent: cue.targetContent || '',
  start: cue.startTimeInSeconds,
  end: cue.endTimeInSeconds,
});

export function createAssistantEditor(getState: () => AssistantEditorState) {
  const identity = crypto.randomUUID();
  let previous: Subtitle[] | undefined;
  let documentId = '';
  let revision = 0;
  const snapshot = (): Partial<AssistantContextSnapshot> => {
    const state = getState();
    if (!state.ready) return { projectId: state.projectId, files: state.files };
    const cues = state.getSubtitles();
    if (previous !== cues || documentId !== state.documentId) {
      previous = cues;
      documentId = state.documentId;
      revision++;
    }
    const offset = Math.max(0, state.selectedIndex - 2);
    return {
      projectId: state.projectId,
      files: state.files,
      editor: {
        documentId,
        revision: `${identity}:${revision}`,
        files: state.files,
        dirty: state.getIsDirty(),
        selectedIndex: state.selectedIndex,
        currentTime: state.currentTime,
        total: cues.length,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        editableFields: state.editableFields,
        cues: cues.slice(offset, offset + 5).map((cue, i) => {
          const data = cueData(cue, offset + i);
          return {
            ...data,
            sourceContent: data.sourceContent.slice(0, 2000),
            targetContent: data.targetContent.slice(0, 2000),
          };
        }),
      },
    };
  };
  const execute = async (
    command: EditorCommand,
  ): Promise<EditorCommandResult> => {
    const context = snapshot();
    if (
      !context.editor ||
      command.documentId !== context.editor.documentId ||
      command.expectedRevision !== context.editor.revision
    )
      throw new Error('EDITOR_CONTEXT_CONFLICT');
    const state = getState();
    const cues = state.getSubtitles();
    const result: Omit<EditorCommandResult, 'context'> = {};
    if (command.kind === 'read') {
      const offset = Math.max(0, command.offset || 0);
      result.cues = cues
        .slice(offset, offset + Math.min(command.limit || 30, 100))
        .map((cue, i) => cueData(cue, offset + i));
    } else if (command.kind === 'edit') {
      const next = cues.slice();
      const seen = new Set<string>();
      for (const edit of command.edits || []) {
        const key = `${edit.index}:${edit.field}`;
        if (
          !Number.isInteger(edit.index) ||
          !next[edit.index] ||
          seen.has(key) ||
          !['sourceContent', 'targetContent'].includes(edit.field)
        )
          throw new Error('INVALID_SUBTITLE_EDIT');
        if (!state.editableFields.includes(edit.field))
          throw new Error(
            `SUBTITLE_FIELD_UNAVAILABLE: ${edit.field} has no editable, persistable target in this document.`,
          );
        seen.add(key);
        next[edit.index] = {
          ...next[edit.index],
          [edit.field]: edit.text,
          ...(edit.field === 'sourceContent'
            ? { content: edit.text.split('\n') }
            : {
                translationStatus: edit.text.trim()
                  ? ('success' as const)
                  : undefined,
                translationError: undefined,
              }),
        };
      }
      if (!seen.size) throw new Error('EMPTY_SUBTITLE_EDIT');
      state.updateSubtitles(next);
      result.changed = seen.size;
    } else if (command.kind === 'locate') {
      if (!Number.isInteger(command.index) || !cues[command.index!])
        throw new Error('INVALID_SUBTITLE_INDEX');
      state.locate(command.index!);
    } else if (command.kind === 'save') {
      if (!(await state.save())) throw new Error('EDITOR_SAVE_FAILED');
      result.saved = true;
    } else throw new Error('UNKNOWN_EDITOR_COMMAND');
    return {
      ...result,
      context: { page: '', capturedAt: Date.now(), ...snapshot() },
    };
  };
  return { priority: 100, snapshot, execute };
}
