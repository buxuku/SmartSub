import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { store } from '../storeManager';
import { getWorkItemById, getWorkItems, saveWorkItem } from '../workItemStore';
import { enqueueTaskSubmission } from '../taskProcessor';
import { wrapFileObject } from '../fileUtils';
import {
  parseSubtitleCues,
  detectSubtitleFormatFromContent,
} from '../subtitleFormats';
import { isProviderConfigured } from '../../../types/provider';
import type {
  DownloadEntry,
  DownloadPipelineConfig,
} from '../../../types/download';
import type { TaskRecipe } from '../../../types/recipe';
import type { TaskSubmission } from '../../../types/taskSubmission';
import type { WorkItem } from '../../../types/workItem';
import { taskSubmissionKey } from '../../../types/taskSubmission';
import { defaultUserConfig } from '../utils';
import { validateDownloadDependencies } from './pipelineReadiness';
import { resolveComposeRunOptions } from '../pipeline/deriveComposeConfig';

/** Snapshot at batch creation, never read a subsequently edited recipe on completion. */
export function resolveDownloadPipeline(
  recipeId: string,
  cloudUploadConsent = false,
): DownloadPipelineConfig {
  const recipe = (store.get('taskRecipes') || []).find(
    (item) => item.id === recipeId,
  ) as TaskRecipe | undefined;
  if (!recipe || recipe.accepts !== 'media' || !recipe.config)
    throw new Error('DOWNLOAD_PIPELINE_RECIPE_REQUIRED');
  if (recipe.goals.dub && !recipe.config.dub)
    throw new Error('DOWNLOAD_PIPELINE_TTS_REQUIRED');
  if (recipe.goals.video && !recipe.config.compose)
    throw new Error('DOWNLOAD_PIPELINE_COMPOSE_REQUIRED');
  const config: Record<string, any> = {
    ...defaultUserConfig,
    ...store.get('userConfig'),
    ...recipe.config,
  };
  delete config.manuscriptPath;
  delete config.manuscriptName;
  delete config.sourceDownloadWorkItemId;
  return {
    version: 1,
    name: recipe.name,
    cloudUploadConsent,
    formData: {
      ...config,
      translateContent: config.translateContent || 'onlyTranslate',
      targetSrtSaveOption: config.targetSrtSaveOption || 'fileNameWithLang',
      customTargetSrtFileName:
        config.customTargetSrtFileName || '${fileName}.${targetLanguage}',
      sourceLanguage: config.sourceLanguage || 'auto',
      targetLanguage: config.targetLanguage || 'zh',
      translateRetryTimes: String(config.translateRetryTimes ?? '3'),
      transcriptionEngine: config.transcriptionEngine || 'builtin',
      taskType: recipe.goals.translate
        ? 'generateAndTranslate'
        : 'generateOnly',
      translateProvider: recipe.goals.translate
        ? config.translateProvider
        : '-1',
      dub: recipe.goals.dub ? config.dub : undefined,
      compose: recipe.goals.video
        ? {
            ...config.compose,
            ...resolveComposeRunOptions(
              config.compose,
              store.get('mergePreferences'),
              process.platform,
            ),
          }
        : undefined,
      gates: config.gates || { subtitle: 'auto', dubbing: 'auto' },
      recipeName: recipe.name,
    },
  };
}

/** Consent is obtained for precisely the configuration the main process resolved. */
export function downloadPipelineKey(config: DownloadPipelineConfig): string {
  return createHash('sha256')
    .update(taskSubmissionKey({ ...config, cloudUploadConsent: false }))
    .digest('hex');
}

const normalizedLanguage = (value?: string) =>
  (value || '').toLowerCase().replace(/_/g, '-');

export function selectDownloadedSubtitle(
  video: string,
  subtitles: string[],
  language?: string,
): string | undefined {
  const stem = path.basename(video, path.extname(video));
  const candidates = subtitles
    .flatMap((file) => {
      const name = path.basename(file, path.extname(file));
      if (
        path.dirname(file) !== path.dirname(video) ||
        !name.startsWith(stem + '.') ||
        !/\.(srt|vtt|ass|ssa)$/i.test(file)
      )
        return [];
      return [
        { file, language: normalizedLanguage(name.slice(stem.length + 1)) },
      ];
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  const desired = normalizedLanguage(language);
  const exact = candidates.filter(
    (candidate) => candidate.language === desired,
  );
  const sameBase = candidates.filter(
    (candidate) => candidate.language.split('-')[0] === desired.split('-')[0],
  );
  const choices =
    desired && desired !== 'auto'
      ? exact.length
        ? exact
        : sameBase
      : candidates;
  // Multiple encodings of one language are fine; multiple languages require a choice.
  if (new Set(choices.map((candidate) => candidate.language)).size !== 1)
    return undefined;
  return (
    choices.find((candidate) => /\.srt$/i.test(candidate.file))?.file ||
    choices[0]?.file
  );
}

function buildSubmission(
  item: WorkItem,
  entry: DownloadEntry,
  config: DownloadPipelineConfig,
): TaskSubmission {
  const paths =
    entry.outputPaths || (entry.outputPath ? [entry.outputPath] : []);
  if (!paths.length) throw new Error('DOWNLOAD_PIPELINE_MEDIA_MISSING');
  const files = paths.map((filePath) => {
    if (!fs.statSync(filePath).isFile())
      throw new Error('DOWNLOAD_PIPELINE_MEDIA_MISSING');
    const sourceLanguage =
      config.formData.sourceLanguage === 'auto'
        ? entry.meta?.language
        : config.formData.sourceLanguage;
    const providedSubtitlePath = selectDownloadedSubtitle(
      filePath,
      entry.subtitlePaths || [],
      sourceLanguage,
    );
    if (providedSubtitlePath) {
      const raw = fs.readFileSync(providedSubtitlePath, 'utf8');
      if (
        !parseSubtitleCues(
          raw,
          detectSubtitleFormatFromContent(providedSubtitlePath, raw),
        ).length
      )
        throw new Error('DOWNLOAD_PIPELINE_SUBTITLE_INVALID');
    }
    return {
      ...wrapFileObject(filePath),
      uuid: createHash('sha256')
        .update(`${item.id}|${entry.id}|${filePath}`)
        .digest('hex'),
      providedSubtitlePath,
    };
  });
  return {
    projectId: `download-${item.id}-${entry.id}`,
    requestId: `download-${entry.id}`,
    name: `${config.name}: ${entry.meta?.title || path.basename(paths[0])}`,
    files,
    formData: {
      ...config.formData,
      taskType:
        config.formData.taskType === 'generateAndTranslate'
          ? 'generateAndTranslate'
          : 'generateOnly',
      sourceDownloadWorkItemId: item.id,
    },
  };
}

function validateDispatch(
  submission: TaskSubmission,
  config: DownloadPipelineConfig,
) {
  for (const file of submission.files) {
    if (!fs.statSync(file.filePath).isFile())
      throw new Error('DOWNLOAD_PIPELINE_MEDIA_MISSING');
    if (file.providedSubtitlePath) {
      if (!fs.statSync(file.providedSubtitlePath).isFile())
        throw new Error('DOWNLOAD_PIPELINE_SUBTITLE_INVALID');
      const raw = fs.readFileSync(file.providedSubtitlePath, 'utf8');
      if (
        !parseSubtitleCues(
          raw,
          detectSubtitleFormatFromContent(file.providedSubtitlePath, raw),
        ).length
      )
        throw new Error('DOWNLOAD_PIPELINE_SUBTITLE_INVALID');
    }
  }
  const form = submission.formData;
  if (
    submission.files.some((file) => !file.providedSubtitlePath) &&
    form.transcriptionEngine === 'cloud' &&
    !config.cloudUploadConsent &&
    store.get('settings')?.cloudUploadConsent !== true
  )
    throw new Error('DOWNLOAD_PIPELINE_CLOUD_CONSENT_REQUIRED');
  if (form.taskType === 'generateAndTranslate') {
    const provider = (store.get('translationProviders') || []).find(
      (candidate) => candidate.id === form.translateProvider,
    );
    if (
      !provider ||
      !isProviderConfigured(provider) ||
      !form.targetLanguage ||
      form.targetLanguage === 'auto'
    )
      throw new Error('DOWNLOAD_PIPELINE_TRANSLATION_REQUIRED');
  }
  validateDownloadDependencies(submission);
}

function persistPipeline(
  itemId: string,
  entryId: string,
  pipeline: NonNullable<DownloadEntry['pipeline']>,
) {
  const item = getWorkItemById(itemId);
  if (!item || item.type !== 'download')
    throw new Error('Download task no longer exists');
  saveWorkItem(
    {
      ...item,
      downloadEntries: item.downloadEntries!.map((entry) =>
        entry.id === entryId ? { ...entry, pipeline } : entry,
      ),
    },
    { durable: true },
  );
}

/** Synchronous durable handoff; parallel download completions cannot interleave. */
export function handoffDownloadEntry(itemId: string, entryId: string): void {
  const item = getWorkItemById(itemId);
  const entry = item?.downloadEntries?.find(
    (candidate) => candidate.id === entryId,
  );
  const config = item?.configSnapshot?.autoChain as
    | DownloadPipelineConfig
    | undefined;
  if (
    !entry ||
    entry.status !== 'done' ||
    !config ||
    entry.pipeline?.status === 'submitted'
  )
    return;
  const projectId = `download-${itemId}-${entryId}`;
  try {
    if (config.version !== 1)
      throw new Error('DOWNLOAD_PIPELINE_CONFIG_INVALID');
    const existing = getWorkItemById(projectId);
    const receipt = existing?.taskSubmissions?.find(
      (submission) => submission.requestId === `download-${entryId}`,
    );
    if (receipt) {
      const original = entry.pipeline?.submission;
      if (
        !original ||
        receipt.fingerprint !==
          createHash('sha256')
            .update(
              taskSubmissionKey({
                files: original.files,
                formData: original.formData,
              }),
            )
            .digest('hex')
      )
        throw new Error('DOWNLOAD_PIPELINE_REQUEST_CONFLICT');
      persistPipeline(itemId, entryId, {
        projectId,
        status: 'submitted',
        subtitlePaths: original.files.flatMap((file) =>
          file.providedSubtitlePath ? [file.providedSubtitlePath] : [],
        ),
      });
      return;
    }
    const submission =
      entry.pipeline?.submission || buildSubmission(item!, entry, config);
    persistPipeline(itemId, entryId, {
      projectId,
      status: 'pending',
      submission,
    });
    validateDispatch(submission, config);
    const result = enqueueTaskSubmission(submission);
    if (!result.success)
      throw new Error(
        'error' in result
          ? result.error
          : 'DOWNLOAD_PIPELINE_SUBMISSION_FAILED',
      );
    persistPipeline(itemId, entryId, {
      projectId,
      status: 'submitted',
      subtitlePaths: submission.files.flatMap((file) =>
        file.providedSubtitlePath ? [file.providedSubtitlePath] : [],
      ),
    });
  } catch (error) {
    const current = getWorkItemById(itemId)?.downloadEntries?.find(
      (candidate) => candidate.id === entryId,
    )?.pipeline;
    persistPipeline(itemId, entryId, {
      ...current,
      projectId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function recoverDownloadHandoffs(): void {
  for (const item of getWorkItems()) {
    if (item.type !== 'download' || !item.configSnapshot?.autoChain) continue;
    for (const entry of item.downloadEntries || []) {
      if (entry.status !== 'done' || entry.pipeline?.status === 'submitted')
        continue;
      // Recover interrupted acceptance only, not an explicit dependency failure.
      if (entry.pipeline?.status === 'error') continue;
      try {
        handoffDownloadEntry(item.id, entry.id);
      } catch (error) {
        console.error('Download pipeline recovery deferred', error);
      }
    }
  }
}
