import fs from 'fs';
import path from 'path';
import type { SubtitleCue } from '../subtitleFormats';
import {
  LEGACY_PROOFREAD_DIR,
  getProofreadDataRoot,
} from '../proofreadDataStorage';
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

/** Absolute, lower-cased form used to decide whether two paths are the same file. */
function normalizeForCompare(filePath: string | undefined): string | null {
  if (!filePath) return null;
  try {
    return path.resolve(filePath).toLowerCase();
  } catch {
    return null;
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

interface SidecarFingerprint {
  mtimeMs: number;
  size: number;
  /** Normalized meta.sourceFile / targetFile / finalTargetFile; null if the file is not a readable sidecar. */
  ownedPaths: string[] | null;
}

/**
 * Per-folder memo of which subtitles each sidecar owns, keyed by the file's
 * mtime and size. The managed folder is shared by every task, so without it
 * each lookup would parse every sidecar again.
 */
const sidecarFingerprints = new Map<string, Map<string, SidecarFingerprint>>();
const MAX_REMEMBERED_FOLDERS = 32;

function readOwnedPaths(filePath: string): string[] | null {
  const data = readSidecar(filePath);
  if (!data) return null;
  return [data.meta.sourceFile, data.meta.targetFile, data.meta.finalTargetFile]
    .map(normalizeForCompare)
    .filter((candidate): candidate is string => candidate !== null);
}

/** Sidecars in `dir` that own `subtitlePath`, most recently modified first. */
function findOwningSidecars(
  dir: string,
  subtitlePath: string,
): Array<{ filePath: string; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    sidecarFingerprints.delete(dir);
    return [];
  }
  const target = normalizeForCompare(subtitlePath);
  const previous = sidecarFingerprints.get(dir);
  // Rebuilt on every scan, so files that were deleted drop out of the memo.
  const current = new Map<string, SidecarFingerprint>();
  const owners: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let fingerprint = previous?.get(filePath);
    if (
      !fingerprint ||
      fingerprint.mtimeMs !== stat.mtimeMs ||
      fingerprint.size !== stat.size
    ) {
      fingerprint = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ownedPaths: readOwnedPaths(filePath),
      };
    }
    current.set(filePath, fingerprint);
    if (target !== null && fingerprint.ownedPaths?.includes(target)) {
      owners.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }
  sidecarFingerprints.delete(dir);
  sidecarFingerprints.set(dir, current);
  if (sidecarFingerprints.size > MAX_REMEMBERED_FOLDERS) {
    const oldest = sidecarFingerprints.keys().next().value;
    if (oldest !== undefined) sidecarFingerprints.delete(oldest);
  }
  // Equal timestamps fall back to the path so the pick stays stable.
  return owners.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.filePath < b.filePath ? 1 : -1),
  );
}

function findInDirectory(
  dir: string,
  subtitlePath: string,
): { filePath: string; data: ProofreadDataFileV2 } | null {
  for (const { filePath } of findOwningSidecars(dir, subtitlePath)) {
    const data = readSidecar(filePath);
    if (data) return { filePath, data };
  }
  return null;
}

/**
 * Find the sidecar whose recorded source/target path owns this subtitle.
 * Looks at the explicit path first, then the managed folder, then the folder
 * next to the subtitle that older versions wrote to. When one folder holds
 * several matches, the most recently modified one wins.
 */
export function findDubbingProofreadDataFile(
  subtitlePath: string,
  explicitPath?: string,
): { filePath: string; data: ProofreadDataFileV2 } | null {
  if (explicitPath && fs.existsSync(explicitPath)) {
    const data = readSidecar(explicitPath);
    if (data) return { filePath: explicitPath, data };
  }

  const managedRoot = getProofreadDataRoot();
  if (managedRoot) {
    const managed = findInDirectory(managedRoot, subtitlePath);
    if (managed) return managed;
  }

  return findInDirectory(
    path.join(path.dirname(subtitlePath), LEGACY_PROOFREAD_DIR),
    subtitlePath,
  );
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
