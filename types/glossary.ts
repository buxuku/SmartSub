/**
 * 全局及项目翻译词库。
 *
 * 缺少 projectId 的旧词库保持全局作用域。项目词库仅在匹配工作项中生效，
 * 优先于全局词库；同一作用域内相同原文由排在最前的词库获胜。
 */

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Glossary {
  id: string;
  projectId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  order: number;
  entries: GlossaryEntry[];
  createdAt: number;
  updatedAt: number;
}

/** 运行期已解析优先级、可直接做批次匹配的词条。 */
export interface ResolvedGlossaryEntry extends GlossaryEntry {
  glossaryId: string;
  glossaryName: string;
  glossaryOrder: number;
  entryOrder: number;
}

export interface GlossaryConflict {
  source: string;
  kept: ResolvedGlossaryEntry;
  ignored: ResolvedGlossaryEntry;
}

export interface GlossaryResolution {
  entries: ResolvedGlossaryEntry[];
  conflicts: GlossaryConflict[];
}

export type GlossaryImportNote =
  | { kind: 'missing' }
  | { kind: 'provided'; value: string };

export interface GlossaryImportEntry {
  source: string;
  target: string;
  note: GlossaryImportNote;
}

export type GlossaryFileFormat = 'csv' | 'txt';
