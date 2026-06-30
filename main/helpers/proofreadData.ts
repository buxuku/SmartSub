import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { IFiles } from '../../types';
import {
  detectSubtitleFormatFromContent,
  parseStartEndTime,
  parseSubtitleEntries,
  toSrtTimeRange,
  type SubtitleEntry,
} from './subtitleFormats';
import { logMessage } from './storeManager';

export interface ProofreadDataCue {
  id: string;
  startMs: number;
  endMs: number;
  source: string;
  target: string;
}

export interface ProofreadDataFile {
  version: 1;
  meta: {
    createdAt: string;
    updatedAt: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    translateContent?: string;
    outputFormat?: string;
    sourceFile?: string;
    targetFile?: string;
    finalTargetFile?: string;
  };
  cues: ProofreadDataCue[];
}

export interface ProofreadSubtitleRow {
  id: string;
  startEndTime: string;
  content: string[];
  sourceContent: string;
  targetContent: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
  isEditing: boolean;
}

function safeFileNamePart(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'subtitle';
}

function hashId(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 12);
}

export function getProofreadDataPath(file: IFiles): string {
  const dir = file.directory || path.dirname(file.filePath);
  const baseName = safeFileNamePart(
    file.fileName || path.basename(file.filePath),
  );
  const id = safeFileNamePart(file.uuid || hashId(file.filePath || baseName));
  return path.join(dir, '.smartsub-proofread', `${baseName}.${id}.json`);
}

async function readSubtitleEntries(
  filePath?: string,
): Promise<SubtitleEntry[]> {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return parseSubtitleEntries(
    content,
    detectSubtitleFormatFromContent(filePath, content),
  );
}

function entryText(entry?: SubtitleEntry): string {
  return entry?.content?.join('\n') ?? '';
}

function buildCues(
  sourceEntries: SubtitleEntry[],
  targetEntries: SubtitleEntry[],
): ProofreadDataCue[] {
  const targetByTime = new Map<string, SubtitleEntry>();
  for (const entry of targetEntries) {
    if (!targetByTime.has(entry.startEndTime)) {
      targetByTime.set(entry.startEndTime, entry);
    }
  }

  return sourceEntries.map((sourceEntry, index) => {
    const targetEntry =
      targetByTime.get(sourceEntry.startEndTime) || targetEntries[index];
    const { startMs, endMs } = parseStartEndTime(sourceEntry.startEndTime);

    return {
      id: sourceEntry.id || String(index + 1),
      startMs,
      endMs,
      source: entryText(sourceEntry),
      target: entryText(targetEntry),
    };
  });
}

export async function writeProofreadDataFromFiles({
  file,
  sourceFile,
  targetFile,
  finalTargetFile,
  sourceLanguage,
  targetLanguage,
  translateContent,
  outputFormat,
}: {
  file: IFiles;
  sourceFile?: string;
  targetFile?: string;
  finalTargetFile?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translateContent?: string;
  outputFormat?: string;
}): Promise<string | null> {
  try {
    const sourceEntries = await readSubtitleEntries(sourceFile);
    if (sourceEntries.length === 0) {
      logMessage(
        `skip proofread data: source subtitle has no cues (${sourceFile})`,
        'warning',
      );
      return null;
    }

    const targetEntries = await readSubtitleEntries(targetFile);
    const now = new Date().toISOString();
    const proofreadData: ProofreadDataFile = {
      version: 1,
      meta: {
        createdAt: now,
        updatedAt: now,
        sourceLanguage,
        targetLanguage,
        translateContent,
        outputFormat,
        sourceFile,
        targetFile,
        finalTargetFile,
      },
      cues: buildCues(sourceEntries, targetEntries),
    };

    const proofreadDataFile = getProofreadDataPath(file);
    await fs.promises.mkdir(path.dirname(proofreadDataFile), {
      recursive: true,
    });
    await fs.promises.writeFile(
      proofreadDataFile,
      JSON.stringify(proofreadData, null, 2),
      'utf-8',
    );
    logMessage(`proofread data written: ${proofreadDataFile}`, 'info');
    return proofreadDataFile;
  } catch (error) {
    logMessage(`write proofread data failed: ${error}`, 'warning');
    return null;
  }
}

export async function readProofreadDataFile(
  filePath: string,
): Promise<ProofreadDataFile> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(content) as ProofreadDataFile;
  if (parsed?.version !== 1 || !Array.isArray(parsed.cues)) {
    throw new Error(`Invalid proofread data file: ${filePath}`);
  }
  return parsed;
}

export function proofreadDataToSubtitleRows(
  data: ProofreadDataFile,
): ProofreadSubtitleRow[] {
  return data.cues.map((cue, index) => {
    const id = cue.id || String(index + 1);
    const sourceContent = cue.source ?? '';
    const targetContent = cue.target ?? '';
    return {
      id,
      startEndTime: toSrtTimeRange(cue.startMs, cue.endMs),
      content: sourceContent.split('\n'),
      sourceContent,
      targetContent,
      startTimeInSeconds: cue.startMs / 1000,
      endTimeInSeconds: cue.endMs / 1000,
      isEditing: false,
    };
  });
}

export async function updateProofreadDataFromSubtitles(
  filePath: string,
  subtitles: ProofreadSubtitleRow[],
): Promise<ProofreadDataFile> {
  const existing = await readProofreadDataFile(filePath);
  const now = new Date().toISOString();
  const updated: ProofreadDataFile = {
    ...existing,
    meta: {
      ...existing.meta,
      updatedAt: now,
    },
    cues: subtitles.map((subtitle, index) => {
      const { startMs, endMs } = parseStartEndTime(subtitle.startEndTime);
      const source =
        subtitle.sourceContent ?? subtitle.content?.join('\n') ?? '';
      return {
        id: subtitle.id || String(index + 1),
        startMs,
        endMs,
        source,
        target: subtitle.targetContent ?? '',
      };
    }),
  };

  await fs.promises.writeFile(
    filePath,
    JSON.stringify(updated, null, 2),
    'utf-8',
  );
  logMessage(`proofread data updated: ${filePath}`, 'info');
  return updated;
}
