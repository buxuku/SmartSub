import fs from 'fs';
import path from 'path';
import {
  getDubbingSessionsRoot,
  getSessionDir,
  getSessionDraftPath,
  readSessionMeta,
  flushSessionMeta,
  stageSessionDeletion,
} from './sessionStore';
import type { WorkItem } from '../../../types/workItem';
import { DubbingOperationStore } from './operationStore';
import { workItemSessionIds } from './workItemSessions';

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isUntouchedCreation(
  meta: NonNullable<ReturnType<typeof readSessionMeta>>,
) {
  return (
    !meta.hasSavedTextEdits &&
    !meta.configSnapshot &&
    !meta.pipelineConfigSnapshot &&
    !Object.keys(meta.speakerVoiceMap || {}).length &&
    !Object.keys(meta.speakerSettings || {}).length &&
    !Object.keys(meta.speakerVoiceConflicts || {}).length &&
    !Object.keys(meta.speakerSettingsConflicts || {}).length &&
    meta.cues.every(
      (cue) => cue.status === 'pending' && !cue.wavFile && !cue.voiceId,
    ) &&
    !['config', 'cue'].some((kind: 'config' | 'cue') =>
      exists(getSessionDraftPath(meta.sessionId, kind)),
    )
  );
}

/** Startup only, before any new synthesis; unknown files and unreadable metadata stay intact. */
export function recoverDubbingArtifacts(items: WorkItem[]): void {
  const referenced = new Set<string>();
  const linkedSessions = new Set(items.flatMap(workItemSessionIds));
  for (const item of items) {
    for (const artifact of item.artifacts || [])
      referenced.add(path.resolve(artifact.path));
    for (const file of item.pipelineFiles || [])
      for (const value of [
        file.dubbedTrackPath,
        file.shiftedSubtitlePath,
        file.dubbedAudioPath,
      ])
        if (value) referenced.add(path.resolve(value));
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getDubbingSessionsRoot(), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error('Dubbing artifact recovery deferred', error);
    return;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(entry.name)
    )
      continue;
    try {
      const meta = readSessionMeta(entry.name);
      if (!meta || meta.sessionId !== entry.name) continue;
      const directory = getSessionDir(entry.name);
      if (meta.pendingTaskLink) {
        if (linkedSessions.has(entry.name)) {
          flushSessionMeta({ ...meta, pendingTaskLink: false }, true);
        } else {
          // Only an explicitly marked, untouched creation is disposable. Older
          // unlinked sessions may contain work and must never be inferred empty.
          const files = fs.readdirSync(directory, { withFileTypes: true });
          if (
            isUntouchedCreation(meta) &&
            !Array.from(referenced).some((file) =>
              file.startsWith(directory + path.sep),
            ) &&
            files.every(
              (file) =>
                file.isFile() &&
                ['session.json', '.session.json.tmp'].includes(file.name),
            )
          )
            stageSessionDeletion([entry.name]).commit();
          continue;
        }
      }
      new DubbingOperationStore().read(entry.name);
      const retained = new Set(
        meta.cues.map((cue) => cue.wavFile).filter(Boolean),
      );
      for (const candidate of fs.readdirSync(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, candidate.name);
        if (referenced.has(file) || retained.has(candidate.name)) continue;
        if (
          candidate.isFile() &&
          /^cue-\d+-\d+-[a-f0-9]{8}(?:-role|-atempo)?\.wav$/.test(
            candidate.name,
          )
        )
          fs.unlinkSync(file);
        else if (
          candidate.isDirectory() &&
          /^dub-track-[a-zA-Z0-9]{6}$/.test(candidate.name) &&
          !Array.from(referenced).some((ref) => ref.startsWith(file + path.sep))
        )
          fs.rmSync(file, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(
        `Dubbing artifact recovery deferred for ${entry.name}`,
        error,
      );
    }
  }
}
