import fs from 'fs';
import { store } from '../storeManager';
import { getModelsInstalled } from '../whisper';
import { getFasterWhisperModelsInstalled } from '../modelCatalog';
import { isRuntimeInstalled } from '../pythonRuntime/paths';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import {
  getInstalledFunasrAsrModels,
  isFunasrVadInstalled,
} from '../funasrModelCatalog';
import {
  getInstalledQwenModels,
  isQwenVadInstalled,
} from '../qwenModelCatalog';
import {
  getInstalledFireRedModels,
  isFireRedVadInstalled,
} from '../fireRedModelCatalog';
import {
  getInstalledParakeetModels,
  isParakeetVadInstalled,
} from '../parakeetModelCatalog';
import { isSpeakerDiarizationModelInstalled } from '../speakerDiarization/modelCatalog';
import {
  TTS_MODELS,
  isTtsModelInstalled,
  type TtsModelId,
} from '../ttsModelCatalog';
import {
  isAsrProviderConfigured,
  parseAsrModels,
} from '../../../types/asrProvider';
import {
  isTtsProviderConfigured,
  parseTtsVoices,
} from '../../../types/ttsProvider';
import { isProviderConfigured } from '../../../types/provider';
import { assertDubbingConfig } from '../../../types/dubbing';
import {
  localTtsLanguageError,
  resolveTtsLanguage,
} from '../../../types/ttsLanguage';
import {
  resolveParakeetSelection,
  isParakeetLanguageMismatch,
} from '../../../types/parakeet';
import { assertValidSubtitleStyle } from '../../../types/subtitleStyleValidation';
import type { TaskSubmission } from '../../../types/taskSubmission';

function assertAsrReady(form: TaskSubmission['formData']): void {
  const model = String(form.model || '').toLowerCase();
  let ready = false;
  switch (form.transcriptionEngine || 'builtin') {
    case 'builtin':
      ready = getModelsInstalled().some((id) => id.toLowerCase() === model);
      break;
    case 'localCli':
      ready = !!model && !!store.get('settings')?.whisperCommand?.trim();
      break;
    case 'fasterWhisper':
      ready =
        isRuntimeInstalled('faster-whisper') &&
        getFasterWhisperModelsInstalled().some(
          (id) => id.toLowerCase() === model,
        );
      break;
    case 'funasr':
      ready =
        isSherpaLibInstalled() &&
        isFunasrVadInstalled() &&
        getInstalledFunasrAsrModels().some((id) => id === model);
      break;
    case 'qwen':
      ready =
        isSherpaLibInstalled() &&
        isQwenVadInstalled() &&
        getInstalledQwenModels().some((id) => id === model);
      break;
    case 'fireRedAsr':
      ready =
        isSherpaLibInstalled() &&
        isFireRedVadInstalled() &&
        getInstalledFireRedModels().some((id) => id === model);
      break;
    case 'parakeet':
      ready =
        isSherpaLibInstalled() &&
        isParakeetVadInstalled() &&
        !!resolveParakeetSelection(model, getInstalledParakeetModels()) &&
        !isParakeetLanguageMismatch(model, form.sourceLanguage);
      break;
    case 'cloud': {
      const provider = (store.get('asrProviders') || []).find(
        (p) => p.id === form.asrProviderId,
      );
      ready =
        isAsrProviderConfigured(provider) &&
        parseAsrModels(provider).some((id) => id.toLowerCase() === model);
      break;
    }
  }
  if (!ready) throw new Error('DOWNLOAD_PIPELINE_ASR_REQUIRED');
}

/** Re-read dependencies at handoff/retry: downloads may outlive settings changes. */
export function validateDownloadDependencies(submission: TaskSubmission): void {
  const form = submission.formData;
  const needsAsr = submission.files.some((file) => !file.providedSubtitlePath);
  if (needsAsr) {
    assertAsrReady(form);
    if (form.aiSegmentation || form.aiCorrection) {
      const id =
        !form.refineProvider || form.refineProvider === 'follow-translation'
          ? form.translateProvider
          : form.refineProvider;
      const provider = (store.get('translationProviders') || []).find(
        (p) => p.id === id,
      );
      if (!provider?.isAi || !isProviderConfigured(provider))
        throw new Error('DOWNLOAD_PIPELINE_REFINE_REQUIRED');
    }
  }
  if (
    form.speakerDiarization &&
    (!isSherpaLibInstalled() || !isSpeakerDiarizationModelInstalled())
  )
    throw new Error('DOWNLOAD_PIPELINE_SPEAKERS_REQUIRED');
  if (
    form.taskType !== 'generateOnly' &&
    form.translateProvider !== '-1' &&
    form.subtitleTranslationStyle === 'conversational'
  ) {
    const provider = (store.get('translationProviders') || []).find(
      (p) => p.id === form.translateProvider,
    );
    if (!provider?.isAi || !isProviderConfigured(provider))
      throw new Error('DOWNLOAD_PIPELINE_TRANSLATION_STYLE_REQUIRED');
  }
  const dub = form.dub;
  if (dub) {
    assertDubbingConfig({ ...dub, background: 'mute', output: 'audioOnly' });
    const clones = store.get('clonedVoices') || [];
    if (dub.engine.kind === 'local') {
      const id = dub.engine.modelId as TtsModelId;
      const model = Object.hasOwn(TTS_MODELS, id) ? TTS_MODELS[id] : undefined;
      if (!model || !isSherpaLibInstalled() || !isTtsModelInstalled(id))
        throw new Error('DOWNLOAD_PIPELINE_TTS_REQUIRED');
      const voice = model.cloneOnly
        ? clones.find((v) => v.engine === 'zipvoice' && v.id === dub.voice)
        : model.voices.find((v) => v.id === dub.voice);
      const clone = model.cloneOnly
        ? clones.find((v) => v.engine === 'zipvoice' && v.id === dub.voice)
        : undefined;
      if (
        !voice ||
        (model.cloneOnly &&
          (!clone?.refWavPath ||
            !clone.refText?.trim() ||
            !fs.existsSync(clone.refWavPath)))
      )
        throw new Error('DOWNLOAD_PIPELINE_VOICE_REQUIRED');
      const language = resolveTtsLanguage({
        language: dub.language,
        subtitleLanguage:
          form.taskType !== 'generateOnly' && form.translateProvider !== '-1'
            ? form.targetLanguage
            : form.sourceLanguage,
        voiceLanguage: 'lang' in voice ? voice.lang : voice.language,
      });
      if (localTtsLanguageError(id, language))
        throw new Error('DOWNLOAD_PIPELINE_TTS_LANGUAGE_REQUIRED');
    } else {
      const provider = (store.get('ttsProviders') || []).find(
        (p) => p.id === dub.engine.providerId,
      );
      if (!isTtsProviderConfigured(provider))
        throw new Error('DOWNLOAD_PIPELINE_TTS_REQUIRED');
      if (
        !parseTtsVoices(provider).includes(dub.voice) &&
        !clones.some(
          (v) =>
            v.engine !== 'zipvoice' &&
            v.providerId === provider!.id &&
            v.trainStatus === 'ready' &&
            v.speakerId === dub.voice,
        )
      )
        throw new Error('DOWNLOAD_PIPELINE_VOICE_REQUIRED');
    }
  }
  const compose = form.compose;
  if (compose) {
    if (
      !['hard', 'soft', 'none'].includes(compose.subtitle) ||
      (compose.subtitle === 'none' && !dub) ||
      (compose.videoQuality &&
        !['original', 'high', 'standard'].includes(compose.videoQuality)) ||
      (compose.encoderMode &&
        !['cpu', 'hardware'].includes(compose.encoderMode))
    )
      throw new Error('DOWNLOAD_PIPELINE_COMPOSE_REQUIRED');
    if (compose.subtitle === 'hard' && compose.style)
      assertValidSubtitleStyle(compose.style);
  }
}
