import fs from 'fs';
import path from 'path';
import { operationMap } from '../../automation/catalog';
import type { AssistantContextSnapshot } from '../../types/assistant';

const canonical = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** Disk writes must never bypass an active editor's revision and undo history. */
export function guardEditorFiles(
  operation: string,
  args: unknown,
  contexts: Iterable<AssistantContextSnapshot>,
) {
  if (operationMap.get(operation)?.readOnly) return;
  const files = new Set(
    Array.from(contexts)
      .flatMap((context) => context.editor?.files || [])
      .map(canonical),
  );
  const check = (value: any, key = '') => {
    if (
      typeof value === 'string' &&
      path.isAbsolute(value) &&
      files.has(canonical(value)) &&
      (/output.*path|output.*file/i.test(key) ||
        ['subtitles.write', 'proofread.save', 'subtitles.sync'].includes(
          operation,
        ))
    ) {
      throw new Error(
        'ACTIVE_EDITOR: Use assistant_editor tools for this document; do not overwrite its files.',
      );
    }
    if (Array.isArray(value)) value.forEach((entry) => check(entry, key));
    else if (value && typeof value === 'object')
      Object.entries(value).forEach(([name, entry]) => check(entry, name));
  };
  check(args);
}
