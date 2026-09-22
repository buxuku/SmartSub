import { useState } from 'react';
import { invalidEngineSettings } from '../../types/engineSettings';
import { useNavigationGuard } from '../context/NavigationGuardContext';
import { useSettingsPersistence } from './useSettingsPersistence';

const defaults = {
  fasterWhisperDevice: 'auto' as 'auto' | 'cpu' | 'cuda',
  fasterWhisperComputeType: 'auto',
  whisperCommand: '',
  useLocalWhisper: false,
};
type EngineSettings = typeof defaults;

export default function useEngineSettings(onSaved: () => void) {
  const [values, setValues] = useState(defaults);
  const [acknowledged, setAcknowledged] = useState(defaults);
  const persistence = useSettingsPersistence((settings) => {
    const invalid = invalidEngineSettings(settings);
    if (invalid.length)
      throw new Error(`INVALID_ENGINE_SETTINGS: ${invalid.join(', ')}`);
    const loaded = Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        settings[key] ?? fallback,
      ]),
    ) as EngineSettings;
    setValues(loaded);
    setAcknowledged(loaded);
  }, onSaved);
  useNavigationGuard('engine-settings', {
    isDirty: persistence.isDirty,
    getIsDirty: persistence.getIsDirty,
    onSave: persistence.save,
    onDiscard: persistence.discard,
  });
  const change = (patch: Partial<EngineSettings>, delay: number | null = 0) => {
    if (!persistence.stage(patch, delay)) return false;
    setValues((previous) => ({ ...previous, ...patch }));
    return true;
  };
  return { values, acknowledged, persistence, change };
}
