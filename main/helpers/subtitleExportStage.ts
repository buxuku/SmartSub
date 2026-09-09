import fs from 'fs';
import path from 'path';
import type { IFiles, IFormData } from '../../types';
import { resolveSubtitleOutputFormats } from '../../types/subtitleOutput';
import { atomicReplaceTextFile } from './atomicFile';
import { ensureTempDir, getMd5 } from './fileUtils';
import { updateProofreadDataOutputs } from './proofreadData';
import { logMessage } from './storeManager';
import {
  writeSubtitleDeliverables,
  type SubtitleDeliverableRequest,
} from './subtitleDeliverables';

/** Only exports from the persisted checkpoint; never performs recognition or translation. */
export async function runSubtitleExportStage(
  event,
  file: IFiles,
  config: IFormData,
  signal?: AbortSignal,
): Promise<void> {
  file.exportSubtitle = 'loading';
  file.exportSubtitleError = undefined;
  event.sender.send('taskFileChange', { ...file });
  const checkpoint = file.subtitleExportCheckpoint;
  if (!checkpoint?.sourceSrtPath)
    throw new Error(
      'Subtitle export source is missing; restore the original subtitle before retrying',
    );
  const { sourceSrtPath, translatedSrtPath, sourceOwned, translationActive } =
    checkpoint;
  const formats = resolveSubtitleOutputFormats(config);
  const hideSource =
    sourceOwned && translationActive && config.sourceSrtSaveOption === 'noSave';
  const requests: SubtitleDeliverableRequest[] = [];
  if (sourceOwned && !hideSource)
    requests.push({ kind: 'source', srtPath: sourceSrtPath, formats });
  if (translationActive && translatedSrtPath)
    requests.push({ kind: 'target', srtPath: translatedSrtPath, formats });
  const outputs = await writeSubtitleDeliverables(
    requests,
    [
      file.filePath,
      file.providedSubtitlePath,
      !requests.some((r) => r.kind === 'source') && sourceSrtPath,
    ].filter(Boolean) as string[],
    signal,
  );
  const cleanup = new Set<string>();
  const cache = async (srtPath: string, role: string) => {
    const cachedPath = path.join(
      ensureTempDir(),
      `${getMd5(`${file.filePath}|${file.uuid}`)}-${role}.srt`,
    );
    await atomicReplaceTextFile(
      cachedPath,
      await fs.promises.readFile(srtPath, 'utf-8'),
      { signal },
    );
    return cachedPath;
  };
  for (const output of outputs) {
    if (output.kind === 'source') {
      file.sourceSubtitleFiles = output.files;
      if (!output.files.includes(output.srtPath))
        file.tempSrtFile = await cache(output.srtPath, 'source');
      file.srtFile = output.files[0];
    } else {
      file.translatedSubtitleFiles = output.files;
      if (!output.files.includes(output.srtPath))
        file.tempFinalSubtitleFile = await cache(output.srtPath, 'final');
      file.translatedSrtFile = output.files[0];
    }
    if (!output.files.includes(output.srtPath)) cleanup.add(output.srtPath);
  }
  if (hideSource) {
    file.tempSrtFile = await cache(sourceSrtPath, 'source');
    file.srtFile = undefined;
    file.sourceSubtitleFiles = [];
    cleanup.add(sourceSrtPath);
  }
  await updateProofreadDataOutputs(file, signal);
  signal?.throwIfAborted();
  // Never remove a checkpoint input before every fallible export/cache/metadata write succeeds.
  for (const srtPath of cleanup) {
    await fs.promises.unlink(srtPath).catch((error) => {
      logMessage(`Cannot remove intermediate SRT: ${error}`, 'warning');
    });
  }
  file.subtitleExportCheckpoint = undefined;
  file.exportSubtitle = 'done';
  event.sender.send('taskFileChange', { ...file });
}
