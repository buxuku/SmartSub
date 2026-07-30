import fs from 'fs';
import type { IFiles, IFormData } from '../../../types';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
  serializeSubtitleCues,
} from '../subtitleFormats';
import { logMessage } from '../storeManager';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { TaskCancelledError } from '../taskContext';
import { annotateCuesWithSpeakers } from './alignment';
import {
  getSpeakerDiarizationModelFiles,
  isSpeakerDiarizationModelInstalled,
} from './modelCatalog';
import { getSpeakerDiarizationRuntime } from './runtime';

interface SubtitleAnnotationPlan {
  filePath: string;
  original: string;
  annotated: string;
}

async function prepareSubtitleAnnotation(
  filePath: string,
  segments: Parameters<typeof annotateCuesWithSpeakers>[1],
): Promise<SubtitleAnnotationPlan | null> {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const format = detectSubtitleFormatFromContent(filePath, content);
  const cues = parseSubtitleCues(content, format);
  if (cues.length === 0) return null;
  const annotated = annotateCuesWithSpeakers(cues, segments);
  return {
    filePath,
    original: content,
    annotated: serializeSubtitleCues(annotated, format),
  };
}

async function applySubtitleAnnotations(
  plans: SubtitleAnnotationPlan[],
): Promise<void> {
  const touched: SubtitleAnnotationPlan[] = [];
  try {
    for (const plan of plans) {
      // 先记录再写，连当前文件的截断/写入错误也会进入回滚。
      touched.push(plan);
      await fs.promises.writeFile(plan.filePath, plan.annotated, 'utf-8');
    }
  } catch (error) {
    for (const plan of touched.reverse()) {
      try {
        await fs.promises.writeFile(plan.filePath, plan.original, 'utf-8');
      } catch (rollbackError) {
        logMessage(
          `speaker diarization rollback failed (${plan.filePath}): ${rollbackError}`,
          'error',
        );
      }
    }
    throw error;
  }
}

/**
 * 可选的说话者分离后处理。失败时保持字幕原样并继续流水线；取消仍严格中止任务。
 *
 * 调用位置在翻译完成之后，因此说话者标签不会污染翻译提示，同时源字幕、译文字幕
 * 和随后生成的 proofread sidecar 都能读到相同标签。
 */
export async function runSpeakerDiarizationStage(input: {
  file: IFiles;
  formData: IFormData | Record<string, any>;
  signal?: AbortSignal;
}): Promise<{ applied: boolean; reason?: string }> {
  const { file, formData, signal } = input;
  if (formData?.speakerDiarization !== true) {
    return { applied: false, reason: 'disabled' };
  }
  if (!file.tempAudioFile || !fs.existsSync(file.tempAudioFile)) {
    logMessage(
      `speaker diarization skipped (${file.fileName}): extracted audio is unavailable`,
      'warning',
    );
    return { applied: false, reason: 'audio-unavailable' };
  }
  if (!isSherpaLibInstalled() || !isSpeakerDiarizationModelInstalled()) {
    logMessage(
      `speaker diarization skipped (${file.fileName}): model is not installed`,
      'warning',
    );
    return { applied: false, reason: 'model-unavailable' };
  }
  if (signal?.aborted) throw new TaskCancelledError();

  const models = getSpeakerDiarizationModelFiles();
  const runtime = getSpeakerDiarizationRuntime();
  const requestedCount = Number(formData?.speakerDiarizationCount);
  let request: ReturnType<typeof runtime.diarize>;
  try {
    request = runtime.diarize({
      audioFile: file.tempAudioFile,
      segmentationModel: models.segmentation,
      embeddingModel: models.embedding,
      numClusters:
        Number.isInteger(requestedCount) && requestedCount >= 2
          ? requestedCount
          : -1,
      numThreads: 2,
    });
  } catch (error) {
    logMessage(
      `speaker diarization could not start; subtitle kept unchanged (${file.fileName}): ${error}`,
      'warning',
    );
    return { applied: false, reason: 'inference-failed' };
  }
  const { id, result } = request;
  const onAbort = () => runtime.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const { segments } = await result;
    if (signal?.aborted) throw new TaskCancelledError();
    if (segments.length === 0) {
      logMessage(
        `speaker diarization returned no segments (${file.fileName}); subtitle unchanged`,
        'warning',
      );
      return { applied: false, reason: 'empty-result' };
    }

    const paths = [
      file.srtFile,
      file.tempSrtFile,
      file.translatedSrtFile,
      file.tempTranslatedSrtFile,
    ].filter((value): value is string => Boolean(value));
    const uniquePaths = Array.from(new Set(paths));
    const plans: SubtitleAnnotationPlan[] = [];
    for (const subtitlePath of uniquePaths) {
      const plan = await prepareSubtitleAnnotation(subtitlePath, segments);
      if (plan) plans.push(plan);
    }
    if (plans.length === 0) {
      logMessage(
        `speaker diarization produced segments but found no subtitle cues (${file.fileName})`,
        'warning',
      );
      return { applied: false, reason: 'subtitle-unavailable' };
    }
    await applySubtitleAnnotations(plans);
    logMessage(
      `speaker diarization applied to ${plans.length} subtitle file(s), ${segments.length} speaker segment(s): ${file.fileName}`,
      'info',
    );
    return { applied: true };
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    logMessage(
      `speaker diarization failed; subtitle kept unchanged (${file.fileName}): ${error}`,
      'warning',
    );
    return { applied: false, reason: 'inference-failed' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
