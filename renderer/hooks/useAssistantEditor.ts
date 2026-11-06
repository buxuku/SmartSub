import { useRef } from 'react';
import {
  createAssistantEditor,
  type AssistantEditorState,
} from '../lib/assistantEditor';
import { useAssistantSource } from '../context/AssistantContext';

export function useAssistantEditor(state: AssistantEditorState) {
  const latest = useRef(state);
  latest.current = state;
  const adapter = useRef<ReturnType<typeof createAssistantEditor>>();
  if (!adapter.current)
    adapter.current = createAssistantEditor(() => latest.current);
  useAssistantSource(adapter.current, [
    state.documentId,
    state.getSubtitles(),
    state.getIsDirty(),
    state.selectedIndex,
    Math.floor(state.currentTime),
    state.ready,
    state.editableFields.join(','),
  ]);
}
