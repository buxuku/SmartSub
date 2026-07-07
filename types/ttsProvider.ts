import type { ProviderField } from './provider';

/**
 * TTS（配音）服务商类型定义，形制对齐 types/asrProvider.ts：
 * - `TtsProviderType` 描述某一类 TTS 服务（OpenAI 兼容 / Edge TTS），驱动配置表单渲染；
 * - `TtsProvider` 是用户配置的实例，持久化在 store.ttsProviders；
 * - 合成时由分发表（TTS_SYNTHESIZER_MAP，main/service/tts）按实例 `type` 路由。
 *
 * 纯类型/常量（不依赖 electron / fs），main、renderer、test:dubbing 均可直接引入。
 */
export type TtsProviderField = ProviderField;

/**
 * 语速控制能力——对齐引擎分支的唯一耦合点（design 定稿）：
 * - native：合成请求原生带 speed/rate 参数（本地 sherpa / OpenAI 兼容 / Edge）；
 * - ssml：经 SSML prosody rate 表达（Azure，v1.5）；
 * - none：无预控制能力，仅能后处理变速（atempo）。
 */
export type TtsSpeedControl = 'native' | 'ssml' | 'none';

/** 服务商/引擎能力声明。 */
export interface TtsCapabilities {
  speedControl: TtsSpeedControl;
  /** 支持声音克隆（v2 zipvoice / ElevenLabs）。 */
  clone?: boolean;
  /** 单请求文本字符上限；超过在发起前报错（v1 不自动切分）。 */
  maxCharsPerRequest?: number;
  /** 云端合成并发上限（并发闸）；本地引擎串行、不声明。 */
  concurrency?: number;
}

/**
 * 单段合成统一合同：所有引擎（本地 worker / 云端 provider）输出
 * 16-bit PCM wav 落盘到 outWavPath，供对齐管线读取与测量。
 */
export interface TtsSegmentRequest {
  text: string;
  voice: string;
  /** 1.0 = 原速；speedControl='native' 时折算为引擎原生参数。 */
  speed?: number;
  outWavPath: string;
  signal?: AbortSignal;
}

/** TTS 服务商类型（schema 驱动表单，字段声明同 ASR/翻译服务商）。 */
export type TtsProviderType = {
  id: string;
  name: string;
  /** 侧栏等窄空间用的品牌短名；缺省回落 name。 */
  shortName?: string;
  fields: TtsProviderField[];
  isBuiltin?: boolean;
  icon?: string;
  iconImg?: string;
  /** 协议型（OpenAI 兼容）允许多实例；品牌型留空硬单例。 */
  multiInstance?: boolean;
  capabilities: TtsCapabilities;
  /**
   * 不稳定通道标注（Edge TTS 逆向接口）：UI 显著提示
   * 「免费试用档，不承诺可用性」，断供错误引导切换其它引擎。
   */
  unstable?: boolean;
};

/** 用户配置的 TTS 服务商实例。type 指向 TtsProviderType.id。 */
export type TtsProvider = {
  id: string;
  name: string;
  type: string;
  /** 来源预设 id（协议型槽位物化标记，语义同 asrProvider.presetId）。 */
  presetId?: string;
  [key: string]: any;
};

/** 云 TTS 服务商类型 id。 */
export const TTS_OPENAI_COMPATIBLE = 'openaiCompatible';
export const TTS_EDGE = 'edge';

/** OpenAI 官方 /audio/speech 单请求文本上限（字符）。 */
const OPENAI_TTS_MAX_CHARS = 4096;
/** Edge 逆向接口的保守单请求上限（官方无文档；2025-12 后按 4096 字节块收紧）。 */
const EDGE_TTS_MAX_CHARS = 1500;

export const TTS_PROVIDER_TYPES: TtsProviderType[] = [
  {
    id: TTS_OPENAI_COMPATIBLE,
    name: 'OpenAI Compatible',
    isBuiltin: true,
    icon: '🔊',
    // 协议型：可对接 OpenAI / 硅基流动 等兼容 /audio/speech 的端点，允许多实例。
    multiInstance: true,
    capabilities: {
      speedControl: 'native', // tts-1(-hd) speed 0.25–4.0
      maxCharsPerRequest: OPENAI_TTS_MAX_CHARS,
      concurrency: 2,
    },
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        defaultValue: 'https://api.openai.com/v1',
        tips: 'ttsApiUrlTips',
        placeholder: 'https://api.openai.com/v1',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'ttsApiKeyTips',
        placeholder: 'phTtsApiKey',
      },
      {
        key: 'model',
        label: 'ttsModel',
        type: 'text',
        required: true,
        defaultValue: 'tts-1',
        tips: 'ttsModelTips',
      },
      {
        // 自由型音色清单（各兼容端点音色不可枚举）：逗号分隔，工作台 voice 下拉的候选池。
        key: 'voices',
        label: 'ttsVoices',
        type: 'text',
        required: true,
        defaultValue: 'alloy, echo, fable, onyx, nova, shimmer',
        tips: 'ttsVoicesTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 60,
        step: 10,
        tips: 'ttsRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 2,
        step: 1,
        tips: 'ttsConcurrencyTips',
      },
    ],
  },
  {
    id: TTS_EDGE,
    name: 'Edge TTS',
    isBuiltin: true,
    icon: '🌐',
    // 逆向接口：免费无 key，但随时可能断供（2025-12 曾大规模断），UI 显著标注试用档。
    unstable: true,
    capabilities: {
      speedControl: 'native', // rate ±%（由 speed 折算）
      maxCharsPerRequest: EDGE_TTS_MAX_CHARS,
      concurrency: 2,
    },
    fields: [
      {
        // 音色清单（微软 Neural 音色名，逗号分隔）；默认给中英常用集。
        key: 'voices',
        label: 'ttsVoices',
        type: 'text',
        required: true,
        defaultValue:
          'zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural, zh-CN-YunyangNeural, zh-CN-XiaoyiNeural, en-US-AriaNeural, en-US-GuyNeural',
        tips: 'ttsVoicesEdgeTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 60,
        step: 10,
        tips: 'ttsRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 2,
        step: 1,
        tips: 'ttsConcurrencyTips',
      },
    ],
  },
];

/** 按 id 取服务商类型定义。 */
export function getTtsProviderType(
  type: string | undefined,
): TtsProviderType | undefined {
  if (!type) return undefined;
  return TTS_PROVIDER_TYPES.find((t) => t.id === type);
}

/** 取某类型的能力声明（未知类型回落最保守：无预控制、串行）。 */
export function getTtsCapabilities(type: string | undefined): TtsCapabilities {
  return (
    getTtsProviderType(type)?.capabilities ?? {
      speedControl: 'none',
      concurrency: 1,
    }
  );
}

/** 命名预设（形制 ASR_PROVIDER_PRESETS）：仅协议型需要。 */
export interface TtsProviderPreset {
  id: string;
  name: string;
  icon?: string;
  values: Record<string, string>;
}

export const TTS_PROVIDER_PRESETS: Record<string, TtsProviderPreset[]> = {
  [TTS_OPENAI_COMPATIBLE]: [
    {
      id: 'openai',
      name: 'OpenAI',
      icon: '🤖',
      values: {
        apiUrl: 'https://api.openai.com/v1',
        model: 'tts-1',
        voices: 'alloy, echo, fable, onyx, nova, shimmer',
      },
    },
    {
      id: 'siliconflow',
      name: 'SiliconFlow 硅基流动',
      icon: '🧊',
      values: {
        apiUrl: 'https://api.siliconflow.cn/v1',
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        voices:
          'FunAudioLLM/CosyVoice2-0.5B:alex, FunAudioLLM/CosyVoice2-0.5B:anna, FunAudioLLM/CosyVoice2-0.5B:bella, FunAudioLLM/CosyVoice2-0.5B:benjamin',
      },
    },
  ],
};

/** 取某类型的命名预设清单（无则空数组）。 */
export function getTtsPresetsForType(
  typeId: string | undefined,
): TtsProviderPreset[] {
  if (!typeId) return [];
  return TTS_PROVIDER_PRESETS[typeId] ?? [];
}

/** 由「类型 + 可选预设」构造新实例（形制 buildInstanceFromPreset）。 */
export function buildTtsInstanceFromPreset(
  type: TtsProviderType,
  preset?: TtsProviderPreset,
  idFactory: () => string = () => `tts_${Date.now()}`,
): TtsProvider {
  const instance: TtsProvider = {
    id: idFactory(),
    name: preset?.name ?? type.name,
    type: type.id,
    ...(preset ? { presetId: preset.id } : {}),
  };
  for (const f of type.fields) {
    if (f.defaultValue !== undefined) instance[f.key] = f.defaultValue;
  }
  if (preset) {
    Object.entries(preset.values).forEach(([k, v]) => {
      instance[k] = v;
    });
  }
  return instance;
}

/**
 * 解析实例的音色候选池：逗号/顿号/分号/换行宽容分隔，去空去重。
 * 空则返回 []（调用方据此判定「未配置音色」）。
 */
export function parseTtsVoices(
  provider: (Partial<TtsProvider> & { voices?: unknown }) | undefined,
): string[] {
  const raw = provider?.voices;
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((m) => String(m).trim());
  } else if (typeof raw === 'string') {
    list = raw.split(/[,，、;；\n]/).map((m) => m.trim());
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of list) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * 就绪判定：所有「必填字段」非空即已配置（voices 至少一个）。
 * Edge 无凭据字段、必填项均有默认值 → 新建即已配置（零配置可用）。
 */
export function isTtsProviderConfigured(
  provider: TtsProvider | undefined,
  type?: TtsProviderType,
): boolean {
  if (!provider) return false;
  const def = type ?? getTtsProviderType(provider.type);
  if (!def) return false;
  return def.fields
    .filter((f) => f.required)
    .every((f) => {
      if (f.key === 'voices') return parseTtsVoices(provider).length > 0;
      const v = provider[f.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
}

/** 实例去重命名（语义同 asrProvider.nextInstanceName）。 */
export function nextTtsInstanceName(
  existing: Pick<TtsProvider, 'name'>[] | undefined,
  base: string,
): string {
  const names = new Set((existing ?? []).map((p) => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

// ── 「配音服务」页左栏条目体系（形制 asrProvider 的 CloudEngineView）─────────
//
// 每个条目 = 一张可直接填写的表单：
// - 品牌型（Edge TTS）→ 一个条目；
// - 协议型（OpenAI 兼容）→ 每个预设一个固定槽位条目（OpenAI / 硅基流动），
//   外加用户「添加自定义」产生的逐实例条目（可扩展更多端点）；
// - 类型下线的孤儿实例 → 按类型兜底一个条目（可查可删）。

export const TTS_VIEW_PREFIX = 'tts:';

export function ttsViewId(typeId: string): string {
  return `${TTS_VIEW_PREFIX}${typeId}`;
}

export function ttsPresetViewId(typeId: string, presetId: string): string {
  return `${TTS_VIEW_PREFIX}${typeId}:${presetId}`;
}

export function ttsCustomViewId(typeId: string, instanceId: string): string {
  return `${TTS_VIEW_PREFIX}${typeId}:i:${instanceId}`;
}

/** 从任意配音服务商视图 id 提取类型 id（首段）；非该体系返回 null。 */
export function ttsViewTypeId(viewId: string | undefined): string | null {
  if (!viewId || !viewId.startsWith(TTS_VIEW_PREFIX)) return null;
  const typeId = viewId.slice(TTS_VIEW_PREFIX.length).split(':')[0];
  return typeId || null;
}

export interface TtsEngineView {
  viewId: string;
  kind: 'brand' | 'preset' | 'custom' | 'orphan';
  type: TtsProviderType;
  label: string;
  icon?: string;
  iconImg?: string;
  preset?: TtsProviderPreset;
  instance?: TtsProvider;
  orphanInstances?: TtsProvider[];
  configured: boolean;
  /** Edge 等不稳定通道（试用档标注透传给左栏/面板）。 */
  unstable?: boolean;
}

/**
 * 产出「在线服务」组条目清单。纯函数，供 TtsServicesTab 渲染与单测。
 * 槽位认领：实例 `presetId` 显式指向该预设（新建槽位物化时打标）。
 */
export function buildTtsViews(
  providers?: TtsProvider[],
  types: TtsProviderType[] = TTS_PROVIDER_TYPES,
  presetsByType: Record<string, TtsProviderPreset[]> = TTS_PROVIDER_PRESETS,
): TtsEngineView[] {
  const list = providers ?? [];
  const knownIds = new Set(types.map((t) => t.id));
  const views: TtsEngineView[] = [];

  for (const type of types) {
    const instances = list.filter((p) => p.type === type.id);

    if (!type.multiInstance) {
      const instance = instances[0];
      views.push({
        viewId: ttsViewId(type.id),
        kind: 'brand',
        type,
        label: type.shortName ?? type.name,
        icon: type.icon,
        iconImg: type.iconImg,
        instance,
        configured: instance ? isTtsProviderConfigured(instance, type) : false,
        unstable: type.unstable,
      });
      continue;
    }

    const presets = presetsByType[type.id] ?? [];
    const claimed = new Set<string>();
    for (const preset of presets) {
      const instance = instances.find(
        (p) => !claimed.has(p.id) && p.presetId === preset.id,
      );
      if (instance) claimed.add(instance.id);
      views.push({
        viewId: ttsPresetViewId(type.id, preset.id),
        kind: 'preset',
        type,
        label: preset.name,
        icon: preset.icon ?? type.icon,
        preset,
        instance,
        configured: instance ? isTtsProviderConfigured(instance, type) : false,
        unstable: type.unstable,
      });
    }
    for (const instance of instances) {
      if (claimed.has(instance.id)) continue;
      views.push({
        viewId: ttsCustomViewId(type.id, instance.id),
        kind: 'custom',
        type,
        label: instance.name,
        instance,
        configured: isTtsProviderConfigured(instance, type),
        unstable: type.unstable,
      });
    }
  }

  // 孤儿类型兜底：类型下线的遗留实例按类型成组追加末尾（可查可删，恒未配置）。
  const orphanByType = new Map<string, TtsProvider[]>();
  for (const p of list) {
    if (knownIds.has(p.type)) continue;
    const arr = orphanByType.get(p.type);
    if (arr) arr.push(p);
    else orphanByType.set(p.type, [p]);
  }
  orphanByType.forEach((orphanInstances, typeId) => {
    views.push({
      viewId: ttsViewId(typeId),
      kind: 'orphan',
      type: {
        id: typeId,
        name: typeId,
        fields: [],
        capabilities: { speedControl: 'none' },
      },
      label: typeId,
      orphanInstances,
      configured: false,
    });
  });
  return views;
}
