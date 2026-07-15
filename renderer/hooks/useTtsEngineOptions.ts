/**
 * TTS 引擎候选（本地模型 / 云服务商实例统一形状）：
 * 配音工作台与新建任务向导共用的加载逻辑（从 useDubbing 抽出）。
 */
import { useState, useCallback, useEffect } from 'react';
import {
  getTtsProviderType,
  isTtsProviderConfigured,
  resolveTtsVoiceLabel,
} from '../../types/ttsProvider';
import type { DubbingEngineSelection } from '../../types/dubbing';

export interface DubbingEngineOption {
  key: string; // local:<modelId> | cloud:<providerId>
  kind: 'local' | 'cloud';
  label: string;
  /** 本地=已安装；云=已配置（isTtsProviderConfigured，必填字段全就绪）。 */
  ready: boolean;
  /** Edge 等不稳定通道标注。 */
  unstable?: boolean;
  /** 云服务商类型 id（计费口径提示按类型分流）。 */
  providerType?: string;
  /** 克隆引擎（zipvoice）：voice 池 = 我的音色，空态引导创建。 */
  cloneOnly?: boolean;
  /** lang 仅克隆音色携带（跨语言提示用）。 */
  voices: Array<{ id: string; label: string; lang?: 'zh' | 'en' }>;
  defaultVoiceId?: string;
}

export function parseEngineKey(key: string): DubbingEngineSelection | null {
  if (key.startsWith('local:')) {
    return { kind: 'local', modelId: key.slice('local:'.length) };
  }
  if (key.startsWith('cloud:')) {
    return { kind: 'cloud', providerId: key.slice('cloud:'.length) };
  }
  return null;
}

export async function loadTtsEngineOptions(): Promise<DubbingEngineOption[]> {
  const opts: DubbingEngineOption[] = [];
  // 克隆音色清单：zipvoice 引擎的 voice 池 + 云端克隆音色（火山/EL）注入对应实例。
  let clonedVoices: Array<{
    id: string;
    name: string;
    engine: string;
    language?: 'zh' | 'en';
    speakerId?: string;
    providerId?: string;
    trainStatus?: string;
  }> = [];
  try {
    const r = await window.ipc.invoke('voiceClone:list');
    if (r?.success) clonedVoices = r.data ?? [];
  } catch {
    /* ignore */
  }
  try {
    const status = await window.ipc.invoke('getTtsModelStatus');
    for (const m of status?.models ?? []) {
      const voices = m.cloneOnly
        ? clonedVoices
            .filter((v) => v.engine === 'zipvoice')
            .map((v) => ({ id: v.id, label: v.name, lang: v.language }))
        : (m.voices ?? []).map((v: any) => ({
            id: v.id,
            label: v.label,
          }));
      opts.push({
        key: `local:${m.id}`,
        kind: 'local',
        label: m.displayName ?? m.id,
        ready: !!m.installed,
        cloneOnly: !!m.cloneOnly,
        voices,
        defaultVoiceId: m.cloneOnly ? voices[0]?.id : m.defaultVoiceId,
      });
    }
  } catch (e) {
    console.error('load tts models failed:', e);
  }
  try {
    const providers = (await window.ipc.invoke('getTtsProviders')) ?? [];
    for (const p of providers) {
      const voices: Array<{ id: string; label: string; lang?: 'zh' | 'en' }> =
        String(p.voices ?? '')
          .split(/[,，、;；\n]/)
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((v: string) => ({
            id: v,
            // voice_id 不可读的服务商（ElevenLabs）按名称映射展示。
            label: resolveTtsVoiceLabel(p, v),
          }));
      // 绑定该实例且就绪的云端克隆音色（火山 S_ 槽位 / EL voice_id）追加进音色池。
      for (const cv of clonedVoices) {
        if (
          cv.engine !== 'zipvoice' &&
          cv.providerId === p.id &&
          cv.trainStatus === 'ready' &&
          cv.speakerId
        ) {
          voices.push({
            id: cv.speakerId,
            label: cv.name,
            lang: cv.language,
          });
        }
      }
      opts.push({
        key: `cloud:${p.id}`,
        kind: 'cloud',
        label: p.name,
        // 必填字段全就绪才可选（半配置的品牌型实例不得进下拉）。
        ready: isTtsProviderConfigured(p),
        unstable: getTtsProviderType(p.type)?.unstable,
        providerType: p.type,
        voices,
        defaultVoiceId: voices[0]?.id,
      });
    }
  } catch (e) {
    console.error('load tts providers failed:', e);
  }
  return opts;
}

export function useTtsEngineOptions() {
  const [engineOptions, setEngineOptions] = useState<DubbingEngineOption[]>([]);
  const refreshEngines = useCallback(async () => {
    setEngineOptions(await loadTtsEngineOptions());
  }, []);
  useEffect(() => {
    refreshEngines();
  }, [refreshEngines]);
  return { engineOptions, refreshEngines };
}
