import type { FileRun, StageId, TaskRun } from '../../../types/taskRun';
import { digestValue } from './service';
import type { StageArtifactStore } from './artifacts';
import { resolveEffectiveSettings } from '../../../types/subtitleOutcome';
const pick = (source: Record<string, any> = {}, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
const provider = (run: TaskRun, id: string) => {
  const selected = run.resolvedConfig.translationProviders?.find(
    (p: any) => p.id === id,
  );
  // Fallback order and all fallback settings affect the result.
  return {
    selected,
    candidates: run.resolvedConfig.translationProviders,
    parameters: run.resolvedConfig.providerParameters,
  };
};
const outputKeys = [
  'translateContent',
  'subtitleOutputFormat',
  'subtitleOutputFormats',
  'subtitleLayout',
  'subtitleLineWidth',
  'sourceSrtSaveOption',
  'targetSrtSaveOption',
  'customSourceSrtFileName',
  'customTargetSrtFileName',
  'removeChinesePunctuation',
  'saveAudio',
];
const nonRecognitionKeys = new Set([
  ...outputKeys,
  'taskType',
  'targetLanguage',
  'translateProvider',
  'translateRetryTimes',
  'subtitleTranslationStyle',
  'aiSegmentation',
  'aiCorrection',
  'subtitleFillerPolicy',
  'refineProvider',
  'manuscriptPath',
  'manuscriptName',
  'glossaryIds',
  'generateSummary',
  'summaryProvider',
  'speakerDiarization',
  'speakerDiarizationCount',
  'speakerDiarizationEmbedInSubtitle',
  'dub',
  'compose',
  'gates',
  'recipeName',
  'maxConcurrentTasks',
  'forceRerun',
]);
export function stageConfiguration(run: TaskRun, id: StageId) {
  const config = run.config;
  const settings = run.resolvedConfig.settings || {};
  if (id === 'prepareInput') return {};
  if (id === 'extractAudio')
    return pick(config, [
      'useEmbeddedSubtitles',
      'speakerDiarization',
      'saveAudio',
    ]);
  if (id === 'extractSubtitle')
    return {
      // New recognition parameters are conservative cache misses unless explicitly owned downstream.
      config: Object.fromEntries(
        Object.entries(config).filter(([key]) => !nonRecognitionKeys.has(key)),
      ),
      settings: Object.fromEntries(
        Object.entries(resolveEffectiveSettings(config, settings)).filter(
          ([key]) =>
            ![
              'language',
              'customLanguages',
              'summaryPrompt',
              'proxyMode',
              'proxyUrl',
              'taskViewMode',
              'closeAction',
              'closeHintShown',
              'lastUsedTranscription',
              'checkUpdateOnStartup',
              'preventSleepDuringTask',
            ].includes(key),
        ),
      ),
      asrProvider: run.resolvedConfig.asrProviders?.find(
        (provider: any) => provider.id === config.asrProviderId,
      ),
      modelIdentity: run.resolvedConfig.modelIdentity,
    };
  if (id === 'refineSubtitle')
    return {
      config: pick(config, [
        'aiSegmentation',
        'aiCorrection',
        'subtitleFillerPolicy',
        'refineProvider',
        'sourceLanguage',
        'targetLanguage',
        'glossaryIds',
        'preserveSpeechPauses',
        'maxSubtitleChars',
        'subtitleMaxDuration',
        'subtitleMaxGap',
      ]),
      provider: provider(
        run,
        config.refineProvider === 'follow-translation' || !config.refineProvider
          ? config.translateProvider
          : config.refineProvider,
      ),
      glossaries: run.resolvedConfig.glossaries,
    };
  if (id === 'manuscriptMatch')
    return pick(config, ['manuscriptPath', 'manuscriptName']);
  if (id === 'normalizeSubtitle') return pick(config, ['sourceLanguage']);
  if (id === 'summarizeEpisode')
    return {
      config: pick(config, [
        'generateSummary',
        'summaryProvider',
        'sourceLanguage',
        'targetLanguage',
        'glossaryIds',
      ]),
      prompt: settings.summaryPrompt,
      languages: settings.customLanguages,
      glossaries: run.resolvedConfig.glossaries,
      provider: provider(
        run,
        config.summaryProvider === 'follow-translation' ||
          !config.summaryProvider
          ? config.translateProvider
          : config.summaryProvider,
      ),
    };
  if (id === 'translateSubtitle')
    return {
      config: pick(config, [
        'sourceLanguage',
        'targetLanguage',
        'translateProvider',
        'translateRetryTimes',
        'subtitleTranslationStyle',
        'glossaryIds',
      ]),
      languages: settings.customLanguages,
      glossaries: run.resolvedConfig.glossaries,
      provider: provider(run, config.translateProvider),
    };
  if (id === 'speakerDiarization')
    return {
      config: pick(config, ['speakerDiarization', 'speakerDiarizationCount']),
      settings: pick(settings, ['speakerDiarizationModelsPath', 'storageRoot']),
    };
  if (id === 'annotateSpeakers')
    return pick(config, ['speakerDiarizationEmbedInSubtitle']);
  if (id === 'prepareProofread')
    return pick(config, ['sourceLanguage', 'targetLanguage', 'glossaryIds']);
  if (id === 'exportSubtitle')
    return {
      ...pick(config, outputKeys),
      translateProviderName:
        run.resolvedConfig.translationProviders?.find(
          (provider: any) => provider.id === config.translateProvider,
        )?.name || '',
    };
  if (id === 'dubbing' || id === 'dubbingTrack')
    return {
      dub: config.dub,
      providers: run.resolvedConfig.ttsProviders,
      voices: run.resolvedConfig.clonedVoices,
      settings: pick(settings, ['ttsModelsPath', 'storageRoot']),
    };
  if (id === 'composeVideo')
    return {
      compose: config.compose,
      preferences: run.resolvedConfig.mergePreferences,
      styles: run.resolvedConfig.mergeStylePresets,
    };
  return config.gates;
}
export function stageFingerprint(
  run: TaskRun,
  file: FileRun,
  id: StageId,
  version = file.stages[id]!.version,
) {
  const input = (file.projection as any).inputDigests || {};
  const stage = file.stages[id]!;
  const inputBindings =
    id === 'extractAudio'
      ? { media: input.media, supplied: Boolean(input.providedSubtitlePath) }
      : id === 'extractSubtitle'
        ? {
            media: input.media,
            subtitle: input.inputSubtitlePath || input.providedSubtitlePath,
          }
        : id === 'manuscriptMatch'
          ? { manuscript: input.manuscriptPath }
          : {};
  const dependencies = stage.dependencies
    .filter((dep) => dep !== 'prepareInput')
    .map((dep) => {
      const upstream = file.stages[dep]!;
      return {
        id: dep,
        fingerprint: upstream.fingerprint,
        degraded: upstream.outcome === 'degraded',
        artifacts: upstream.artifacts.map((a) => ({
          kind: a.kind,
          digest: a.digest,
        })),
      };
    });
  return digestValue({
    id,
    version,
    config: stageConfiguration(run, id),
    inputBindings,
    dependencies,
    manualInput: [
      'exportSubtitle',
      'dubbing',
      'dubbingTrack',
      'composeVideo',
    ].includes(id)
      ? {
          proofread: (file.projection as any).manualProofreadRevision,
          dubbing: (file.projection as any).manualDubbingRevision,
        }
      : undefined,
  });
}
export async function decideStageReuse(input: {
  run: TaskRun;
  file: FileRun;
  stageId: StageId;
  previous: TaskRun | null;
  artifacts: StageArtifactStore;
  signal?: AbortSignal;
  force?: boolean;
}) {
  const { run, file, stageId, previous, artifacts, signal } = input;
  const fingerprint = stageFingerprint(run, file, stageId);
  const reject = (reason: string) => ({
    reusable: false as const,
    reason,
    fingerprint,
  });
  if (input.force) return reject('FORCED');
  if (stageId === 'prepareInput' || stageId.endsWith('Review'))
    return reject('RUN_LOCAL_STAGE');
  if (
    stageId === 'extractSubtitle' &&
    run.config.transcriptionEngine === 'localCli'
  )
    return reject('EXTERNAL_ENGINE_UNVERIFIED');
  if (
    !previous ||
    previous.projectId !== run.projectId ||
    previous.runId !== run.previousRunId
  )
    return reject('NO_PREVIOUS_RUN');
  const old = previous.files.find(
    (candidate) => candidate.fileId === file.fileId,
  )?.stages[stageId];
  if (!old || old.status !== 'succeeded') return reject('NO_COMMITTED_RESULT');
  if (old.outcome === 'degraded') return reject('DEGRADED_RESULT');
  if (old.artifacts.some((artifact) => artifact.provenance === 'manual'))
    return reject('MANUAL_RESULT');
  if (old.fingerprint !== fingerprint) return reject('FINGERPRINT_CHANGED');
  if (!(await artifacts.validate(old.artifacts, signal)))
    return reject('ARTIFACT_INVALID');
  return {
    reusable: true as const,
    reason: 'UNCHANGED',
    fingerprint,
    artifacts: old.artifacts,
    patch: artifacts.readPatch(old.artifacts),
    reusedFrom: previous.runId,
  };
}
