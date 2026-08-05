import fs from 'fs';
import path from 'path';
import type { SubtitleCue } from '../subtitleFormats';
import {
  normalizePrimarySpeakerId,
  normalizeProofreadData,
  normalizeSpeakerIds,
  type ProofreadDataFileV2,
} from '../../../types/proofreadData';
import type { DubbingSpeaker } from '../../../types/dubbing';

export interface DubbingCueSpeakerAssignment {
  speakerIds?: number[];
  primarySpeakerId?: number;
}

export interface DubbingSpeakerMetadata {
  proofreadDataFile?: string;
  speakers: DubbingSpeaker[];
  assignments: DubbingCueSpeakerAssignment[];
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    return (
      path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    );
  } catch {
    return false;
  }
}

function readSidecar(filePath: string): ProofreadDataFileV2 | null {
  try {
    return normalizeProofreadData(
      JSON.parse(fs.readFileSync(filePath, 'utf-8')),
    );
  } catch {
    return null;
  }
}

/** Find the sidecar whose recorded source/target path owns this subtitle. */
export function findDubbingProofreadDataFile(
  subtitlePath: string,
  explicitPath?: string,
): { filePath: string; data: ProofreadDataFileV2 } | null {
  if (explicitPath && fs.existsSync(explicitPath)) {
    const data = readSidecar(explicitPath);
    if (data) return { filePath: explicitPath, data };
  }

  const sidecarDir = path.join(
    path.dirname(subtitlePath),
    '.smartsub-proofread',
  );
  if (!fs.existsSync(sidecarDir)) return null;
  let candidates: string[] = [];
  try {
    candidates = fs
      .readdirSync(sidecarDir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .map((name) => path.join(sidecarDir, name));
  } catch {
    return null;
  }
  for (const filePath of candidates) {
    const data = readSidecar(filePath);
    if (!data) continue;
    const metaPaths = [
      data.meta.sourceFile,
      data.meta.targetFile,
      data.meta.finalTargetFile,
    ];
    if (metaPaths.some((candidate) => samePath(candidate, subtitlePath))) {
      return { filePath, data };
    }
  }
  return null;
}

function cueKey(startMs: number, endMs: number): string {
  return `${Math.round(startMs)}:${Math.round(endMs)}`;
}

/** Align sidecar role metadata to parsed dubbing cues without reading labels from text. */
export function loadDubbingSpeakerMetadata(
  subtitlePath: string,
  parsedCues: readonly SubtitleCue[],
  explicitPath?: string,
): DubbingSpeakerMetadata {
  const found = findDubbingProofreadDataFile(subtitlePath, explicitPath);
  if (!found) {
    return { speakers: [], assignments: parsedCues.map(() => ({})) };
  }

  const byTime = new Map<string, number[]>();
  found.data.cues.forEach((cue, index) => {
    const key = cueKey(cue.startMs, cue.endMs);
    const indexes = byTime.get(key) || [];
    indexes.push(index);
    byTime.set(key, indexes);
  });
  const used = new Set<number>();
  const assignments = parsedCues.map((cue, index) => {
    const exact = (byTime.get(cueKey(cue.startMs, cue.endMs)) || []).find(
      (candidate) => !used.has(candidate),
    );
    const sidecarIndex =
      exact !== undefined
        ? exact
        : found.data.cues.length === parsedCues.length
          ? index
          : undefined;
    if (sidecarIndex === undefined) return {};
    used.add(sidecarIndex);
    const sidecarCue = found.data.cues[sidecarIndex];
    const speakerIds = normalizeSpeakerIds(sidecarCue.speakerIds);
    if (!speakerIds.length) {
      return Object.prototype.hasOwnProperty.call(sidecarCue, 'speakerIds')
        ? { speakerIds: [] }
        : {};
    }
    return {
      speakerIds,
      primarySpeakerId: normalizePrimarySpeakerId(
        sidecarCue.primarySpeakerId,
        speakerIds,
      ),
    };
  });

  const firstAppearance: number[] = [];
  const seen = new Set<number>();
  for (const assignment of assignments) {
    const ids = normalizeSpeakerIds(assignment.speakerIds);
    const primary = normalizePrimarySpeakerId(assignment.primarySpeakerId, ids);
    const ordered = primary
      ? [primary, ...ids.filter((id) => id !== primary)]
      : ids;
    for (const id of ordered) {
      if (seen.has(id)) continue;
      seen.add(id);
      firstAppearance.push(id);
    }
  }
  const roster = new Map(
    found.data.speakers.map((speaker) => [speaker.id, speaker]),
  );
  const speakers = firstAppearance.map((id) => {
    const speaker = roster.get(id);
    let cueCount = 0;
    let totalDurationMs = 0;
    assignments.forEach((assignment, index) => {
      if (!normalizeSpeakerIds(assignment.speakerIds).includes(id)) return;
      cueCount += 1;
      totalDurationMs += Math.max(
        0,
        parsedCues[index].endMs - parsedCues[index].startMs,
      );
    });
    return {
      id,
      name: speaker?.displayName || `Speaker ${id}`,
      color: speaker?.color || '#64748b',
      cueCount,
      totalDurationMs,
    };
  });

  return {
    proofreadDataFile: found.filePath,
    speakers,
    assignments,
  };
}
