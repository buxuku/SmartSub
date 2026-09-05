/**
 * 本地多语 TTS 的语言级前端规则选择（无语言信息时回退音色）。
 *
 * sherpa-onnx 的 ruleFsts 属于 OfflineTts 模型级配置，不会随 sid 切换，因此
 * Kokoro 模型包里的中文 phone/date/number FST 也会改写英文音色的数字（例如
 * `1` 被读成 yi）。英文配音跳过这些规则，交给 Kokoro 的 espeak-ng
 * 英文前端处理；中文配音保留原规则，与所选 sid 无关。
 */

import { ttsBaseLanguage } from '../../../types/ttsLanguage';

interface VoiceLanguageProfile {
  id: string;
  lang: 'zh' | 'en';
}

interface VoiceAwareModelSpec {
  id: string;
  defaultVoiceId: string;
  voices: VoiceLanguageProfile[];
}

interface RuleFstModelRequest {
  ruleFsts?: string;
}

const KOKORO_MULTI_LANG_MODEL_ID = 'kokoro-multi-lang-v1_1';

function resolveVoice(
  spec: VoiceAwareModelSpec,
  voiceId: string | undefined,
): VoiceLanguageProfile | undefined {
  return (
    spec.voices.find((voice) => voice.id === voiceId) ??
    spec.voices.find((voice) => voice.id === spec.defaultVoiceId)
  );
}

export function resolveTtsModelRequestForVoice<T extends RuleFstModelRequest>(
  spec: VoiceAwareModelSpec,
  model: T,
  voiceId?: string,
  language?: string,
): T {
  const voice = resolveVoice(spec, voiceId);
  const effectiveLanguage = ttsBaseLanguage(language) ?? voice?.lang;
  if (
    spec.id !== KOKORO_MULTI_LANG_MODEL_ID ||
    effectiveLanguage !== 'en' ||
    !model.ruleFsts
  ) {
    return model;
  }

  const englishModel = { ...model };
  delete englishModel.ruleFsts;
  return englishModel;
}
