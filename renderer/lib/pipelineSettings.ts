import type { PipelineComposeConfig, PipelineDubConfig } from '../../types';
import type { UserStylePreset } from '../../types/subtitleMerge';
import type { DubbingEngineOption } from '../hooks/useTtsEngineOptions';
import { parseEngineKey } from '../hooks/useTtsEngineOptions';
import {
  STYLE_PRESETS,
  getDefaultStyle,
  getPlatformDefaultFont,
} from '../components/subtitleMerge/constants';

export interface DubbingSelection
  extends Partial<Omit<PipelineDubConfig, 'engine'>> {
  engineKey: string;
  voice: string;
}

export function dubbingEngineKey(engine?: PipelineDubConfig['engine']): string {
  if (!engine) return '';
  return engine.kind === 'local'
    ? `local:${engine.modelId}`
    : `cloud:${engine.providerId}`;
}

/** Only empty, new selections take defaults. A saved choice is never substituted. */
export function resolveDubbingSelection(
  value: DubbingSelection,
  engines: DubbingEngineOption[],
): DubbingSelection {
  const engine = value.engineKey
    ? engines.find((option) => option.key === value.engineKey)
    : engines.find((option) => option.ready);
  return {
    ...value,
    engineKey: value.engineKey || engine?.key || '',
    voice: value.voice || engine?.defaultVoiceId || engine?.voices[0]?.id || '',
  };
}

export function dubbingConfigFromSelection(
  value: DubbingSelection,
): Partial<PipelineDubConfig> {
  const { engineKey, ...config } = value;
  return {
    globalSpeed: 1,
    language: 'auto',
    cloneQuality: 'standard',
    localConcurrency: 1,
    overflow: 'truncate',
    overlapMode: 'shift',
    ...config,
    engine: parseEngineKey(engineKey) || undefined,
  };
}

/** Resolve a style only on an explicit selection, never on resource refresh. */
export function selectComposeStyle(
  value: PipelineComposeConfig,
  id: string,
  userPresets: UserStylePreset[],
  translate: (key: string) => string,
): PipelineComposeConfig {
  const user = userPresets.find((preset) => preset.id === id);
  const system = STYLE_PRESETS.find((preset) => preset.id === id);
  if (!user && !system) return value;
  return {
    ...value,
    styleId: id,
    styleName: user?.name || translate(system!.nameKey) || system!.name,
    style: user
      ? { ...getDefaultStyle(), ...user.style }
      : {
          ...system!.style,
          ...(id === 'classic' ? { fontName: getPlatformDefaultFont() } : {}),
        },
  };
}

export function initialComposeConfig(
  translate: (key: string) => string,
): PipelineComposeConfig {
  return selectComposeStyle({ subtitle: 'hard' }, 'classic', [], translate);
}

export function withComposeDefaults(
  value: PipelineComposeConfig,
  preferences: Pick<PipelineComposeConfig, 'videoQuality' | 'encoderMode'>,
): PipelineComposeConfig {
  return {
    ...value,
    videoQuality: value.videoQuality ?? preferences.videoQuality ?? 'original',
    encoderMode: value.encoderMode ?? preferences.encoderMode ?? 'cpu',
  };
}
