import { isSubtitleFile } from './utils';
import { hasUnavailableParakeetModel } from './engineModels';

/** Check fresh installation state for every start/retry, including autostart. */
export async function canStartParakeetTask(
  files: Array<{
    filePath?: string;
    providedSubtitlePath?: string;
    extractSubtitle?: unknown;
    srtFile?: string;
    tempSrtFile?: string;
    embeddedSubtitle?: boolean;
  }>,
  needsModel: boolean,
  formData: {
    transcriptionEngine?: string;
    model?: string;
    dub?: unknown;
    compose?: unknown;
    useEmbeddedSubtitles?: boolean;
  },
): Promise<boolean> {
  if (!needsModel || formData.transcriptionEngine !== 'parakeet') return true;
  try {
    const exists = async (filePath?: string) =>
      !!filePath &&
      (await window?.ipc?.invoke('checkFileExists', { filePath }))?.exists ===
        true;
    const requiresAsr = await Promise.all(
      files.map(async (file) => {
        if (isSubtitleFile(file.filePath || '')) return false;
        if (await exists(file.providedSubtitlePath)) return false;
        if (
          (formData.dub || formData.compose) &&
          file.extractSubtitle === 'done' &&
          !(
            formData.useEmbeddedSubtitles === false &&
            file.embeddedSubtitle === true
          ) &&
          ((await exists(file.srtFile)) || (await exists(file.tempSrtFile)))
        )
          return false;
        return true;
      }),
    );
    if (!requiresAsr.some(Boolean)) return true;
    const status = await window?.ipc?.invoke('getParakeetModelStatus');
    if (!status?.success || !status.engineInstalled) return false;
    return !hasUnavailableParakeetModel(
      {
        parakeetVadInstalled: status.vadInstalled,
        parakeetModelsInstalled: status.models
          .filter((m: { installed: boolean }) => m.installed)
          .map((m: { id: string }) => m.id),
      },
      formData,
    );
  } catch {
    return false;
  }
}
