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
import {
  annotateCuesWithSpeakers,
  type SpeakerDiarizationSegment,
} from './alignment';
import {
  getSpeakerDiarizationModelFiles,
  isSpeakerDiarizationModelInstalled,
} from './modelCatalog';
import { getSpeakerDiarizationRuntime } from './runtime';
import {
  normalizeSpeakerDiarizationCount,
  shouldEmbedSpeakerLabels,
} from '../../../types/speakerDiarization';

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
 * 可选的角色分离后处理。失败时保持字幕原样并继续任务；取消仍严格中止任务。
 *
 * 调用位置在翻译完成之后，因此角色信息不会污染翻译提示。推理片段始终供 proofread
 * sidecar 写入 metadata；只有用户显式开启时才额外把可读标签渲染进字幕文件。
 */
export interface SpeakerDiarizationStageResult {
  /** 推理成功并得到可写入 sidecar 的角色片段。 */
  applied: boolean;
  /** 是否实际把可读标签写入至少一个字幕文件。 */
  embedded: boolean;
  segments?: SpeakerDiarizationSegment[];
  reason?: string;
}

export async function runSpeakerDiarizationStage(input: {
  file: IFiles;
  formData: IFormData | Record<string, any>;
  signal?: AbortSignal;
}): Promise<SpeakerDiarizationStageResult> {
  const { file, formData, signal } = input;
  if (formData?.speakerDiarization !== true) {
    return { applied: false, embedded: false, reason: 'disabled' };
  }
  if (!file.tempAudioFile || !fs.existsSync(file.tempAudioFile)) {
    logMessage(
      `speaker diarization skipped (${file.fileName}): extracted audio is unavailable`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'audio-unavailable' };
  }
  if (!isSherpaLibInstalled() || !isSpeakerDiarizationModelInstalled()) {
    logMessage(
      `speaker diarization skipped (${file.fileName}): runtime or model is unavailable`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'model-unavailable' };
  }
  if (signal?.aborted) throw new TaskCancelledError();

  const models = getSpeakerDiarizationModelFiles();
  const runtime = getSpeakerDiarizationRuntime();
  let request: ReturnType<typeof runtime.diarize>;
  try {
    request = runtime.diarize({
      audioFile: file.tempAudioFile,
      segmentationModel: models.segmentation,
      embeddingModel: models.embedding,
      numClusters: normalizeSpeakerDiarizationCount(
        formData?.speakerDiarizationCount,
      ),
      numThreads: 2,
    });
  } catch (error) {
    logMessage(
      `speaker diarization could not start; subtitle kept unchanged (${file.fileName}): ${error}`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'inference-failed' };
  }
  const { id, result } = request;
  const onAbort = () => runtime.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });

  let segments: SpeakerDiarizationSegment[];
  try {
    segments = (await result).segments;
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    logMessage(
      `speaker diarization failed; subtitle kept unchanged (${file.fileName}): ${error}`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'inference-failed' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) throw new TaskCancelledError();
  if (segments.length === 0) {
    logMessage(
      `speaker diarization returned no segments (${file.fileName}); subtitle unchanged`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'empty-result' };
  }

  if (!shouldEmbedSpeakerLabels(formData)) {
    logMessage(
      `speaker diarization metadata ready (${segments.length} segment(s)); subtitle files kept unchanged: ${file.fileName}`,
      'info',
    );
    return { applied: true, embedded: false, segments };
  }

  try {
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
    if (signal?.aborted) throw new TaskCancelledError();
    if (plans.length === 0) {
      logMessage(
        `speaker diarization produced segments but found no subtitle cues (${file.fileName})`,
        'warning',
      );
      return {
        applied: true,
        embedded: false,
        segments,
        reason: 'subtitle-unavailable',
      };
    }
    await applySubtitleAnnotations(plans);
    logMessage(
      `speaker diarization embedded labels in ${plans.length} subtitle file(s), ${segments.length} speaker segment(s): ${file.fileName}`,
      'info',
    );
    return { applied: true, embedded: true, segments };
  } catch (error) {
    if (signal?.aborted) throw new TaskCancelledError();
    logMessage(
      `speaker diarization label embedding failed; metadata kept and subtitle files restored (${file.fileName}): ${error}`,
      'warning',
    );
    return {
      applied: true,
      embedded: false,
      segments,
      reason: 'annotation-failed',
    };
  }
}
