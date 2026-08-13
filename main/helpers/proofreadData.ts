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
import {
  speakerIdsForCues,
  stripSpeakerLabelPrefix,
  type SpeakerDiarizationSegment,
} from './speakerDiarization/alignment';
import {
  mergeSpeakerIds,
  realignSpeakerIdsForCue,
} from '../../types/speakerDiarization';
import {
  PROOFREAD_DATA_VERSION,
  hasExplicitSpeakerAssignment,
  normalizePrimarySpeakerId,
  normalizeProofreadData,
  normalizeSpeakerIds,
  normalizeSpeakerRoster,
  shouldRealignSpeakerAssignment,
  type ProofreadDataCue,
  type ProofreadDataFileV2,
  type SpeakerInfo,
} from '../../types/proofreadData';

export type { ProofreadDataCue, SpeakerInfo } from '../../types/proofreadData';
export type ProofreadDataFile = ProofreadDataFileV2;

export interface ProofreadSubtitleRow {
  id: string;
  startEndTime: string;
  content: string[];
  sourceContent: string;
  targetContent: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
  isEditing: boolean;
  speakerIds?: number[];
  primarySpeakerId?: number;
  speakerAssignmentSource?: 'manual';
}

export type ProofreadDataWriteResult =
  | { ok: true; filePath: string }
  | {
      ok: false;
      reason: 'source-unavailable' | 'write-failed';
      error?: string;
    };

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
  speakerSegments: SpeakerDiarizationSegment[] = [],
): ProofreadDataCue[] {
  const targetByTime = new Map<string, SubtitleEntry>();
  for (const entry of targetEntries) {
    if (!targetByTime.has(entry.startEndTime)) {
      targetByTime.set(entry.startEndTime, entry);
    }
  }

  const timedCues = sourceEntries.map((sourceEntry) => {
    const { startMs, endMs } = parseStartEndTime(sourceEntry.startEndTime);
    return { startMs, endMs, text: entryText(sourceEntry) };
  });
  const speakerIds = speakerIdsForCues(timedCues, speakerSegments);

  return sourceEntries.map((sourceEntry, index) => {
    const targetEntry =
      targetByTime.get(sourceEntry.startEndTime) || targetEntries[index];
    const { startMs, endMs } = parseStartEndTime(sourceEntry.startEndTime);

    const assignedSpeakerIds = normalizeSpeakerIds(speakerIds[index]);
    const cleanSpeakerPrefix = assignedSpeakerIds.length > 0;
    const cue: ProofreadDataCue = {
      id: sourceEntry.id || String(index + 1),
      startMs,
      endMs,
      source: cleanSpeakerPrefix
        ? stripSpeakerLabelPrefix(entryText(sourceEntry))
        : entryText(sourceEntry),
      target: cleanSpeakerPrefix
        ? stripSpeakerLabelPrefix(entryText(targetEntry))
        : entryText(targetEntry),
    };
    if (assignedSpeakerIds.length) {
      cue.speakerIds = assignedSpeakerIds;
      cue.primarySpeakerId = assignedSpeakerIds[0];
    }
    return cue;
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
  speakerSegments,
  glossaryIds,
  episodeSummary,
}: {
  file: IFiles;
  sourceFile?: string;
  targetFile?: string;
  finalTargetFile?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translateContent?: string;
  outputFormat?: string;
  speakerSegments?: SpeakerDiarizationSegment[];
  glossaryIds?: string[];
  episodeSummary?: string;
}): Promise<ProofreadDataWriteResult> {
  try {
    const sourceEntries = await readSubtitleEntries(sourceFile);
    if (sourceEntries.length === 0) {
      logMessage(
        `skip proofread data: source subtitle has no cues (${sourceFile})`,
        'warning',
      );
      return { ok: false, reason: 'source-unavailable' };
    }

    const targetEntries = await readSubtitleEntries(targetFile);
    const now = new Date().toISOString();
    const cues = buildCues(sourceEntries, targetEntries, speakerSegments);
    const proofreadData: ProofreadDataFile = {
      version: PROOFREAD_DATA_VERSION,
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
        ...(glossaryIds !== undefined ? { glossaryIds } : {}),
        ...(episodeSummary ? { episodeSummary } : {}),
      },
      speakers: normalizeSpeakerRoster([], cues),
      cues,
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
    return { ok: true, filePath: proofreadDataFile };
  } catch (error) {
    logMessage(`write proofread data failed: ${error}`, 'warning');
    return {
      ok: false,
      reason: 'write-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readProofreadDataFile(
  filePath: string,
): Promise<ProofreadDataFile> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  try {
    const raw = JSON.parse(content);
    const normalized = normalizeProofreadData(raw);
    // v1 was created while technical labels could still be embedded in the
    // source/target text. Keep migration idempotent and only strip labels from
    // cues that already carry structured speaker assignments.
    if (raw?.version === 1) {
      normalized.cues = normalized.cues.map((cue) =>
        cue.speakerIds?.length
          ? {
              ...cue,
              source: stripSpeakerLabelPrefix(cue.source),
              target: stripSpeakerLabelPrefix(cue.target),
            }
          : cue,
      );
    }
    return normalized;
  } catch {
    throw new Error(`Invalid proofread data file: ${filePath}`);
  }
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
      ...(hasExplicitSpeakerAssignment(cue)
        ? { speakerIds: [...(cue.speakerIds || [])] }
        : {}),
      ...(cue.primarySpeakerId
        ? { primarySpeakerId: cue.primarySpeakerId }
        : {}),
      ...(cue.speakerAssignmentSource === 'manual'
        ? { speakerAssignmentSource: 'manual' as const }
        : {}),
    };
  });
}

export async function updateProofreadDataFromSubtitles(
  filePath: string,
  subtitles: ProofreadSubtitleRow[],
  speakers?: SpeakerInfo[],
): Promise<ProofreadDataFile> {
  const existing = await readProofreadDataFile(filePath);
  const existingById = new Map(existing.cues.map((cue) => [cue.id, cue]));
  const now = new Date().toISOString();
  const updated: ProofreadDataFile = {
    ...existing,
    version: PROOFREAD_DATA_VERSION,
    meta: {
      ...existing.meta,
      updatedAt: now,
    },
    speakers: normalizeSpeakerRoster(speakers || existing.speakers, subtitles),
    cues: subtitles.map((subtitle, index) => {
      const { startMs, endMs } = parseStartEndTime(subtitle.startEndTime);
      const source =
        subtitle.sourceContent ?? subtitle.content?.join('\n') ?? '';
      const previous = existingById.get(subtitle.id) || existing.cues[index];
      const timingChanged = Boolean(
        previous && (previous.startMs !== startMs || previous.endMs !== endMs),
      );
      const hasCurrentAssignment = hasExplicitSpeakerAssignment(subtitle);
      const currentSpeakerIds = hasCurrentAssignment
        ? subtitle.speakerIds
        : previous?.speakerIds;
      const speakerAssignmentSource =
        subtitle.speakerAssignmentSource || previous?.speakerAssignmentSource;
      // Timing-based realignment is only valid for automatic assignments.
      // Once the user has corrected a cue, the current row (including an
      // explicit empty array) is authoritative across timing edits and saves.
      const speakerIds = shouldRealignSpeakerAssignment(
        timingChanged,
        speakerAssignmentSource,
      )
        ? realignSpeakerIdsForCue(
            startMs,
            endMs,
            existing.cues,
            currentSpeakerIds,
          )
        : mergeSpeakerIds(currentSpeakerIds);
      const normalizedSpeakerIds = normalizeSpeakerIds(speakerIds);
      const primarySpeakerId = normalizePrimarySpeakerId(
        subtitle.primarySpeakerId ?? previous?.primarySpeakerId,
        normalizedSpeakerIds,
      );
      return {
        id: subtitle.id || String(index + 1),
        startMs,
        endMs,
        source,
        target: subtitle.targetContent ?? '',
        ...(normalizedSpeakerIds.length || speakerAssignmentSource === 'manual'
          ? {
              speakerIds: normalizedSpeakerIds,
              ...(primarySpeakerId ? { primarySpeakerId } : {}),
            }
          : {}),
        ...(speakerAssignmentSource === 'manual'
          ? { speakerAssignmentSource: 'manual' as const }
          : {}),
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
