import fs from 'fs';
import path from 'path';
import { atomicReplaceTextFile } from '../atomicFile';
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
  signal?: AbortSignal,
): Promise<void> {
  const touched: SubtitleAnnotationPlan[] = [];
  try {
    for (const plan of plans) {
      await atomicReplaceTextFile(plan.filePath, plan.annotated, { signal });
      touched.push(plan);
    }
  } catch (error) {
    for (const plan of touched.reverse()) {
      try {
        await atomicReplaceTextFile(plan.filePath, plan.original);
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
  if (signal?.aborted) throw new TaskCancelledError();
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

  let runtime: ReturnType<typeof getSpeakerDiarizationRuntime>;
  let request: ReturnType<typeof runtime.diarize>;
  try {
    const models = getSpeakerDiarizationModelFiles();
    runtime = getSpeakerDiarizationRuntime();
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
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    logMessage(
      `speaker diarization could not start; subtitle kept unchanged (${file.fileName}): ${error}`,
      'warning',
    );
    return { applied: false, embedded: false, reason: 'inference-failed' };
  }
  const { id, result } = request;
  const onAbort = () => runtime.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

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
    const protectedPaths = [file.filePath, file.providedSubtitlePath].filter(
      Boolean,
    ) as string[];
    const protectedInodes = new Set<string>();
    for (const protectedPath of protectedPaths) {
      const stat = await fs.promises.stat(protectedPath);
      protectedInodes.add(`${stat.dev}:${stat.ino}`);
    }
    const uniquePaths: string[] = [];
    const seen = new Set<string>();
    let protectedSubtitleFound = false;
    for (const candidate of paths) {
      if (!fs.existsSync(candidate)) continue;
      const stat = await fs.promises.stat(candidate);
      const identity = `${stat.dev}:${stat.ino}`;
      if (
        protectedInodes.has(identity) ||
        protectedPaths.some(
          (input) => path.resolve(input) === path.resolve(candidate),
        )
      ) {
        protectedSubtitleFound = true;
        continue;
      }
      // Resolve symlinks, but update each owned hardlink: atomic rename detaches it.
      const resolved = await fs.promises.realpath(candidate);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        uniquePaths.push(resolved);
      }
    }
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
        reason: protectedSubtitleFound
          ? 'imported-subtitle-protected'
          : 'subtitle-unavailable',
      };
    }
    await applySubtitleAnnotations(plans, signal);
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
