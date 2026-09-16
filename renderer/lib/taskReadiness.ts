import type { TaskTypeDef } from './taskTypes';
import type { EngineModelInfo } from './engineModels';
import { getEngineModelGroups, isEngineModelSelected } from './engineModels';
import { isSubtitleFile } from './utils';
import { isProviderConfigured, type Provider } from '../../types/provider';
import type { AsrProvider } from '../../types/asrProvider';
import type { TranscriptionEngine } from '../../types/engine';
import { resolveParakeetSelection } from '../../types/parakeet';
import { loadTtsEngineOptions } from '../hooks/useTtsEngineOptions';
import {
  localTtsLanguageError,
  resolveTtsLanguage,
} from '../../types/ttsLanguage';
import {
  validateRefineProviderConfig,
  type RefineValidationResult,
} from './subtitleRefineValidation';

export interface TaskReadinessFile {
  filePath: string;
  providedSubtitlePath?: string;
  extractSubtitle?: unknown;
  srtFile?: string;
  tempSrtFile?: string;
  embeddedSubtitle?: boolean;
  speakerDiarization?: unknown;
  proofreadDataFile?: string;
  proofreadDataReady?: unknown;
  exportSubtitle?: unknown;
}

export interface TaskReadinessInput {
  files: TaskReadinessFile[];
  typeDef: TaskTypeDef;
  formData: Record<string, any>;
  systemInfo?: EngineModelInfo;
  providers?: Provider[];
  asrProviders?: AsrProvider[];
  includeLocalCli?: boolean;
  whisperCommand?: string;
  translateOn?: boolean;
}

export interface ValidationReadyResult {
  valid: boolean;
  errors: string[];
  needsTranscription: boolean;
  refine: RefineValidationResult;
}

export function validateTaskConfigReady({
  files,
  typeDef,
  formData,
  systemInfo,
  providers = [],
  asrProviders = [],
  includeLocalCli = false,
  whisperCommand,
  translateOn = typeDef.hasTranslate &&
    !(
      Boolean(formData.dub || formData.compose) &&
      formData.translateProvider === '-1'
    ),
}: TaskReadinessInput): ValidationReadyResult {
  const errors: string[] = [];
  if (
    formData.speakerDiarization === true &&
    files.some(
      (file) =>
        !isSubtitleFile(file.filePath) &&
        !(
          file.speakerDiarization === 'done' &&
          file.proofreadDataReady === 'done' &&
          file.exportSubtitle === 'done' &&
          file.proofreadDataFile &&
          !(formData.useEmbeddedSubtitles === false && file.embeddedSubtitle) &&
          (formData.dub || formData.compose)
        ),
    ) &&
    (!systemInfo?.speakerDiarizationModelInstalled ||
      !systemInfo?.speakerDiarizationRuntimeInstalled)
  ) {
    errors.push('speaker_diarization_unavailable');
  }
  if (!files.length) errors.push('files_required');
  if (
    typeDef.accepts === 'subtitle' &&
    files.some((file) => !isSubtitleFile(file.filePath))
  )
    errors.push('subtitle_files_required');
  const needsTranscription =
    typeDef.needsModel &&
    files.some(
      (file) => !isSubtitleFile(file.filePath) && !file.providedSubtitlePath,
    );
  if (needsTranscription) {
    const engine = (formData.transcriptionEngine ||
      (includeLocalCli ? 'localCli' : 'builtin')) as TranscriptionEngine;
    const model =
      engine === 'parakeet'
        ? resolveParakeetSelection(
            formData.model,
            systemInfo?.parakeetModelsInstalled || [],
          )?.id
        : formData.model;
    const groups = getEngineModelGroups(systemInfo, {
      includeLocalCli,
      asrProviders,
    });
    if (!model) errors.push('model_required');
    else if (
      !groups.some((group) =>
        isEngineModelSelected(group, {
          engine,
          model,
          asrProviderId: formData.asrProviderId,
        }),
      )
    )
      errors.push('model_unavailable');
    if (engine === 'localCli' && !whisperCommand?.trim())
      errors.push('local_command_required');
  }
  if (translateOn) {
    if (!formData.targetLanguage || formData.targetLanguage === 'auto')
      errors.push('target_language_required');
    const provider = providers.find(
      (candidate) => candidate.id === formData.translateProvider,
    );
    if (!provider || !isProviderConfigured(provider))
      errors.push('provider_required');
    else if (
      formData.subtitleTranslationStyle === 'conversational' &&
      !provider.isAi
    )
      errors.push('translation_style_requires_ai');
  }
  const refine = validateRefineProviderConfig({
    formData: needsTranscription ? formData : {},
    providers,
    translateOn,
  });
  if (!refine.valid) errors.push('refine_provider_required');
  return { valid: errors.length === 0, errors, needsTranscription, refine };
}

/** Start and retry both refresh dependencies; stale UI lists never authorize dispatch. */
export async function validateTaskStart(
  input: Pick<
    TaskReadinessInput,
    'files' | 'typeDef' | 'formData' | 'translateOn'
  >,
): Promise<ValidationReadyResult> {
  const [systemInfo, providers, asrProviders, settings] = await Promise.all([
    window.ipc.invoke('getSystemInfo'),
    window.ipc.invoke('getTranslationProviders'),
    window.ipc.invoke('getAsrProviders'),
    window.ipc.invoke('getSettings'),
  ]);
  const missing: string[] = [];
  const files: TaskReadinessFile[] = [];
  const exists = async (filePath?: string) =>
    Boolean(filePath) &&
    (await window.ipc.invoke('checkFileExists', { filePath }))?.exists === true;
  for (const file of input.files) {
    if (!(await exists(file.filePath))) missing.push('input_unavailable');
    if (file.providedSubtitlePath && !(await exists(file.providedSubtitlePath)))
      missing.push('paired_subtitle_unavailable');
    // A resumed compose/dub stage can use the already-persisted transcript.
    let transcript = file.providedSubtitlePath;
    if (
      !transcript &&
      (input.formData.dub || input.formData.compose) &&
      file.extractSubtitle === 'done' &&
      !(input.formData.useEmbeddedSubtitles === false && file.embeddedSubtitle)
    ) {
      if (await exists(file.srtFile)) transcript = file.srtFile;
      else if (await exists(file.tempSrtFile)) transcript = file.tempSrtFile;
    }
    files.push({
      ...file,
      providedSubtitlePath: transcript,
      proofreadDataFile: (await exists(file.proofreadDataFile))
        ? file.proofreadDataFile
        : undefined,
    });
  }
  const result = validateTaskConfigReady({
    ...input,
    files,
    systemInfo,
    providers: providers || [],
    asrProviders: asrProviders || [],
    includeLocalCli: settings?.useLocalWhisper === true,
    whisperCommand: settings?.whisperCommand,
  });
  const dub = input.formData.dub;
  if (dub) {
    const engines = await loadTtsEngineOptions();
    const selected =
      dub.engine?.kind === 'local'
        ? `local:${dub.engine.modelId}`
        : `cloud:${dub.engine?.providerId}`;
    const engine = engines.find((candidate) => candidate.key === selected);
    const voice = engine?.voices.find(
      (candidate) => candidate.id === dub.voice,
    );
    if (!engine?.ready) missing.push('tts_unavailable');
    else if (!voice) missing.push('tts_voice_unavailable');
    else if (
      engine.kind === 'local' &&
      localTtsLanguageError(
        dub.engine.modelId,
        resolveTtsLanguage({
          language: dub.language,
          subtitleLanguage:
            input.formData.translateProvider &&
            input.formData.translateProvider !== '-1'
              ? input.formData.targetLanguage
              : input.formData.sourceLanguage,
          voiceLanguage: voice.lang,
        }),
      )
    )
      missing.push('tts_language_unsupported');
  }
  const errors = Array.from(new Set([...missing, ...result.errors]));
  return { ...result, errors, valid: errors.length === 0 };
}
