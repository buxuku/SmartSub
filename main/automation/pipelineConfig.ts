import { isProviderConfigured, type Provider } from '../../types/provider';
import type { TaskSubmission } from '../../types/taskSubmission';

export interface AutomationCallOptions {
  /** Trusted in-app context, never inferred from an external tool argument. */
  assistantProviderId?: string;
}

export function isSubtitleInput(file: string) {
  return /\.(srt|vtt|ass|ssa|txt|lrc)$/i.test(file);
}

/** Keep resource preferences, but optional processing stages require task overrides. */
export function resolvePipelineForm(
  operation: string,
  args: any,
  defaults: Record<string, any>,
  providers: Provider[],
  options: AutomationCallOptions = {},
) {
  const form = {
    ...defaults,
    aiSegmentation: false,
    aiCorrection: false,
    speakerDiarization: false,
    subtitleTranslationStyle: 'neutral',
    dub: undefined,
    compose: undefined,
    manuscriptPath: undefined,
    ...args.config,
    taskType:
      operation === 'transcribe'
        ? 'generateOnly'
        : operation === 'translate'
          ? 'translateOnly'
          : args.taskType,
    gates: args.config?.gates || { subtitle: 'auto', dubbing: 'auto' },
    sourceSrtSaveOption: 'fileNameWithLang',
    targetSrtSaveOption: 'fileNameWithLang',
  } as TaskSubmission['formData'];
  for (const [key, target] of [
    ['engine', 'transcriptionEngine'],
    ['model', 'model'],
    ['sourceLanguage', 'sourceLanguage'],
    ['targetLanguage', 'targetLanguage'],
  ])
    if (args[key] !== undefined) form[target] = args[key];
  form.transcriptionEngine ||= 'builtin';
  if (args.providerId) {
    if (operation === 'transcribe') {
      if (form.transcriptionEngine !== 'cloud')
        throw new Error(
          'PROVIDER_ROLE_MISMATCH: transcribe.providerId selects a cloud ASR provider and requires engine="cloud". For AI segmentation/correction use config.refineProvider from providers.list(kind="translation").',
        );
      form.asrProviderId = args.providerId;
    } else form.translateProvider = args.providerId;
  }
  const needsAsr =
    form.taskType !== 'translateOnly' &&
    args.files.some((file: string) => !isSubtitleInput(file));
  if (needsAsr && (form.aiSegmentation || form.aiCorrection)) {
    const configuredAi = (id: string) => {
      const provider = providers.find((p) => p.id === id);
      return !!provider?.isAi && isProviderConfigured(provider);
    };
    const setting = form.refineProvider;
    const follows = !setting || setting === 'follow-translation';
    if (follows && configuredAi(form.translateProvider)) {
      // Pin the exact service, including for original-only subtitle tasks.
      form.refineProvider = form.translateProvider;
    } else if (
      follows &&
      args.config?.refineProvider === undefined &&
      options.assistantProviderId &&
      configuredAi(options.assistantProviderId)
    ) {
      form.refineProvider = options.assistantProviderId;
    }
    // Explicit IDs (including stale saved IDs) are never silently replaced.
    if (!configuredAi(form.refineProvider))
      throw new Error(
        'REFINE_PROVIDER_REQUIRED: AI segmentation/correction requires a configured AI refinement service. Read providers.list(kind="translation") and set config.refineProvider to an isAi=true, configured=true provider ID. preserveSpeechPauses alone does not require AI. Keep requested features enabled; disable them only if the user did not request them.',
      );
  }
  return form;
}

/** Preserve desktop/download error codes there; give automation callers actionable errors. */
export function automationDependencyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const hints: Record<string, [string, string]> = {
    DOWNLOAD_PIPELINE_ASR_REQUIRED: [
      'ASR_DEPENDENCY_REQUIRED',
      'The selected ASR engine/model is unavailable or incompatible with sourceLanguage. Read engines.list and models.list; for cloud ASR read providers.list(kind="asr") and select a model listed by that provider using config.asrProviderId. Chat/translation providers cannot be used as ASR providers.',
    ],
    DOWNLOAD_PIPELINE_REFINE_REQUIRED: [
      'REFINE_PROVIDER_REQUIRED',
      'AI segmentation/correction requires config.refineProvider from providers.list(kind="translation") with isAi=true and configured=true.',
    ],
    DOWNLOAD_PIPELINE_SPEAKERS_REQUIRED: [
      'SPEAKER_MODEL_REQUIRED',
      'Speaker diarization requires the Sherpa runtime and speaker diarization models. Inspect models.list. Install the missing resources if requested, or omit config.speakerDiarization if speaker identification was not requested.',
    ],
    DOWNLOAD_PIPELINE_TRANSLATION_STYLE_REQUIRED: [
      'TRANSLATION_STYLE_PROVIDER_REQUIRED',
      'Conversational translation requires a configured AI translation provider. Read providers.list(kind="translation") and set config.translateProvider to an isAi=true provider, or use subtitleTranslationStyle="neutral" if conversational style was not requested.',
    ],
    DOWNLOAD_PIPELINE_TTS_REQUIRED: [
      'TTS_DEPENDENCY_REQUIRED',
      'Dubbing requires an installed local TTS model/runtime or a configured TTS provider. Read models.list or providers.list(kind="tts"); set config.dub.engine. Chat/ASR providers are not TTS providers.',
    ],
    DOWNLOAD_PIPELINE_VOICE_REQUIRED: [
      'TTS_VOICE_REQUIRED',
      'The selected voice is unavailable for this TTS engine. Read tts.voices and voices.list; cloud clones must be ready and belong to the selected provider, local clones need their reference audio and transcript.',
    ],
    DOWNLOAD_PIPELINE_TTS_LANGUAGE_REQUIRED: [
      'TTS_LANGUAGE_UNSUPPORTED',
      'The local TTS model does not support the requested subtitle/dubbing language. Read models.list and select a compatible model; set config.dub.language to the actual spoken language.',
    ],
    DOWNLOAD_PIPELINE_COMPOSE_REQUIRED: [
      'COMPOSE_CONFIG_INVALID',
      'Use config.compose.subtitle="hard" or "soft" for subtitle composition. subtitle="none" requires config.dub. Inspect pipeline.run schema for videoQuality and encoderMode.',
    ],
  };
  const hint = hints[message];
  return hint
    ? new Error(`${hint[0]}: ${hint[1]}`)
    : error instanceof Error
      ? error
      : new Error(message);
}
