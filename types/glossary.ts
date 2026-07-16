/**
 * 全局翻译词库。
 *
 * 词库是应用级资源，不进入任务 formData / snapshot。所有启用词库按 order
 * 依次参与 AI 翻译和 AI 校对；相同原文由排在最前的词库获胜。
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

export interface GlossaryImportEntry {
  source: string;
  target: string;
  note?: string;
}

export type GlossaryFileFormat = 'csv' | 'txt';
