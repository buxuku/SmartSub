import { randomUUID } from 'crypto';
import type {
  Glossary,
  GlossaryEntry,
  GlossaryImportEntry,
  GlossaryResolution,
  ResolvedGlossaryEntry,
} from '../../types/glossary';
import {
  GLOSSARY_LIMITS,
  glossarySourceKey,
  normalizeGlossaries,
  resolveEnabledGlossaryEntries,
} from '../glossary/core';
import { logMessage, store } from './storeManager';

export class GlossaryManagerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GlossaryManagerError';
  }
}

function cleaned(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function writeGlossaries(glossaries: Glossary[]): Glossary[] {
  const normalized = normalizeGlossaries(glossaries).map((glossary, order) => ({
    ...glossary,
    order,
  }));
  store.set('glossaries', normalized);
  return normalized;
}

export function listGlossaries(): Glossary[] {
  return normalizeGlossaries(store.get('glossaries'));
}

export function getGlossary(id: string): Glossary | null {
  return listGlossaries().find((glossary) => glossary.id === id) || null;
}

function ensureUniqueGlossaryName(
  glossaries: Glossary[],
  name: string,
  ignoreId?: string,
): void {
  const key = name.toLowerCase();
  if (
    glossaries.some(
      (glossary) =>
        glossary.id !== ignoreId && glossary.name.toLowerCase() === key,
    )
  ) {
    throw new GlossaryManagerError('DUPLICATE_GLOSSARY_NAME');
  }
}

export function createGlossary(input: {
  name?: string;
  description?: string;
}): Glossary {
  const glossaries = listGlossaries();
  const name = cleaned(input?.name, GLOSSARY_LIMITS.name);
  if (!name) throw new GlossaryManagerError('GLOSSARY_NAME_REQUIRED');
  ensureUniqueGlossaryName(glossaries, name);
  const now = Date.now();
  const glossary: Glossary = {
    id: randomUUID(),
    name,
    ...(cleaned(input?.description, GLOSSARY_LIMITS.description)
      ? {
          description: cleaned(input?.description, GLOSSARY_LIMITS.description),
        }
      : {}),
    enabled: true,
    order: glossaries.length,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
  writeGlossaries([...glossaries, glossary]);
  return glossary;
}

export function updateGlossary(
  id: string,
  patch: { name?: string; description?: string; enabled?: boolean },
): Glossary {
  const glossaries = listGlossaries();
  const index = glossaries.findIndex((glossary) => glossary.id === id);
  if (index < 0) throw new GlossaryManagerError('GLOSSARY_NOT_FOUND');
  const current = glossaries[index];
  const name =
    patch.name === undefined
      ? current.name
      : cleaned(patch.name, GLOSSARY_LIMITS.name);
  if (!name) throw new GlossaryManagerError('GLOSSARY_NAME_REQUIRED');
  ensureUniqueGlossaryName(glossaries, name, id);
  const description =
    patch.description === undefined
      ? current.description || ''
      : cleaned(patch.description, GLOSSARY_LIMITS.description);
  const updated: Glossary = {
    ...current,
    name,
    ...(description ? { description } : { description: undefined }),
    enabled:
      patch.enabled === undefined ? current.enabled : patch.enabled === true,
    updatedAt: Date.now(),
  };
  glossaries[index] = updated;
  writeGlossaries(glossaries);
  return updated;
}

export function deleteGlossary(id: string): boolean {
  const glossaries = listGlossaries();
  const next = glossaries.filter((glossary) => glossary.id !== id);
  if (next.length === glossaries.length) return false;
  writeGlossaries(next);
  return true;
}

export function moveGlossary(id: string, direction: -1 | 1): Glossary[] {
  const glossaries = listGlossaries();
  const index = glossaries.findIndex((glossary) => glossary.id === id);
  if (index < 0) throw new GlossaryManagerError('GLOSSARY_NOT_FOUND');
  const target = index + direction;
  if (target < 0 || target >= glossaries.length) return glossaries;
  [glossaries[index], glossaries[target]] = [
    glossaries[target],
    glossaries[index],
  ];
  return writeGlossaries(glossaries);
}

function normalizeEntryInput(input: Partial<GlossaryEntry>): {
  source: string;
  target: string;
  note: string;
} {
  const source = cleaned(input?.source, GLOSSARY_LIMITS.source);
  const target = cleaned(input?.target, GLOSSARY_LIMITS.target);
  const note = cleaned(input?.note, GLOSSARY_LIMITS.note);
  if (!source) throw new GlossaryManagerError('ENTRY_SOURCE_REQUIRED');
  if (!target) throw new GlossaryManagerError('ENTRY_TARGET_REQUIRED');
  return { source, target, note };
}

export function saveGlossaryEntry(
  glossaryId: string,
  input: Partial<GlossaryEntry>,
): GlossaryEntry {
  const glossaries = listGlossaries();
  const glossaryIndex = glossaries.findIndex(
    (glossary) => glossary.id === glossaryId,
  );
  if (glossaryIndex < 0) {
    throw new GlossaryManagerError('GLOSSARY_NOT_FOUND');
  }
  const glossary = glossaries[glossaryIndex];
  const { source, target, note } = normalizeEntryInput(input);
  const duplicate = glossary.entries.find(
    (entry) =>
      entry.id !== input.id &&
      glossarySourceKey(entry.source) === glossarySourceKey(source),
  );
  if (duplicate) throw new GlossaryManagerError('DUPLICATE_ENTRY_SOURCE');

  const now = Date.now();
  const entryIndex = input.id
    ? glossary.entries.findIndex((entry) => entry.id === input.id)
    : -1;
  const entry: GlossaryEntry = {
    id: entryIndex >= 0 ? glossary.entries[entryIndex].id : randomUUID(),
    source,
    target,
    ...(note ? { note } : {}),
    createdAt: entryIndex >= 0 ? glossary.entries[entryIndex].createdAt : now,
    updatedAt: now,
  };
  if (entryIndex >= 0) glossary.entries[entryIndex] = entry;
  else glossary.entries.push(entry);
  glossary.updatedAt = now;
  glossaries[glossaryIndex] = glossary;
  writeGlossaries(glossaries);
  return entry;
}

export function deleteGlossaryEntry(
  glossaryId: string,
  entryId: string,
): boolean {
  const glossaries = listGlossaries();
  const glossaryIndex = glossaries.findIndex(
    (glossary) => glossary.id === glossaryId,
  );
  if (glossaryIndex < 0) return false;
  const glossary = glossaries[glossaryIndex];
  const nextEntries = glossary.entries.filter((entry) => entry.id !== entryId);
  if (nextEntries.length === glossary.entries.length) return false;
  glossaries[glossaryIndex] = {
    ...glossary,
    entries: nextEntries,
    updatedAt: Date.now(),
  };
  writeGlossaries(glossaries);
  return true;
}

export function importGlossaryEntries(
  glossaryId: string,
  imported: GlossaryImportEntry[],
): {
  glossary: Glossary;
  added: number;
  updated: number;
  skipped: number;
} {
  const glossaries = listGlossaries();
  const glossaryIndex = glossaries.findIndex(
    (glossary) => glossary.id === glossaryId,
  );
  if (glossaryIndex < 0) {
    throw new GlossaryManagerError('GLOSSARY_NOT_FOUND');
  }
  const glossary = glossaries[glossaryIndex];
  const bySource = new Map(
    glossary.entries.map((entry, index) => [
      glossarySourceKey(entry.source),
      index,
    ]),
  );
  let added = 0;
  let updated = 0;
  let skipped = 0;

  imported.forEach((input) => {
    let normalized: ReturnType<typeof normalizeEntryInput>;
    try {
      normalized = normalizeEntryInput(input);
    } catch {
      skipped++;
      return;
    }
    const key = glossarySourceKey(normalized.source);
    const index = bySource.get(key);
    const now = Date.now();
    if (index === undefined) {
      const entry: GlossaryEntry = {
        id: randomUUID(),
        source: normalized.source,
        target: normalized.target,
        ...(normalized.note ? { note: normalized.note } : {}),
        createdAt: now,
        updatedAt: now,
      };
      bySource.set(key, glossary.entries.length);
      glossary.entries.push(entry);
      added++;
      return;
    }
    const current = glossary.entries[index];
    if (
      current.target === normalized.target &&
      (current.note || '') === normalized.note
    ) {
      skipped++;
      return;
    }
    glossary.entries[index] = {
      ...current,
      source: normalized.source,
      target: normalized.target,
      ...(normalized.note ? { note: normalized.note } : { note: undefined }),
      updatedAt: now,
    };
    updated++;
  });

  glossary.updatedAt = Date.now();
  glossaries[glossaryIndex] = glossary;
  writeGlossaries(glossaries);
  return { glossary, added, updated, skipped };
}

/** 读取运行期快照并把重复原文的优先级选择写入现有日志系统。 */
export function getActiveGlossaryResolution(): GlossaryResolution {
  const resolution = resolveEnabledGlossaryEntries(listGlossaries());
  resolution.conflicts.forEach((conflict) => {
    logMessage(
      `词库原文冲突「${conflict.source}」：按词库顺序采用「${conflict.kept.glossaryName}」中的“${conflict.kept.target}”，忽略「${conflict.ignored.glossaryName}」中的“${conflict.ignored.target}”`,
      'warning',
    );
  });
  return resolution;
}

export function logGlossaryMatches(
  matches: ResolvedGlossaryEntry[],
  context: string,
): void {
  if (!matches.length) return;
  const visible = matches.slice(0, 50);
  const remainder = matches.length - visible.length;
  logMessage(
    `词库命中（${context}）：${visible
      .map(
        (entry) => `${entry.source} → ${entry.target} [${entry.glossaryName}]`,
      )
      .join('；')}${remainder > 0 ? `；另有 ${remainder} 条命中` : ''}`,
    'info',
  );
}
