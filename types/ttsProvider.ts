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
  /**
   * 支持经服务商 API 在线拉取音色清单（配置面板出现「拉取音色」）：
   * - replace：清单替换为账号实际可用集并回填名称（ElevenLabs，账号音色少）；
   * - label：仅为当前清单回填名称映射、不动清单（Azure，全量 700+ 不宜灌入）。
   */
  voiceListMode?: 'replace' | 'label';
  /** 音色/语音库官方文档链接（配置面板出现「音色文档」外链）。 */
  docsUrl?: string;
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
export const TTS_AZURE_SPEECH = 'azureSpeech';
export const TTS_ELEVENLABS = 'elevenlabs';
export const TTS_VOLCENGINE = 'volcengine';

/** OpenAI 官方 /audio/speech 单请求文本上限（字符）。 */
const OPENAI_TTS_MAX_CHARS = 4096;
/** Edge 逆向接口的保守单请求上限（官方无文档；2025-12 后按 4096 字节块收紧）。 */
const EDGE_TTS_MAX_CHARS = 1500;
/** Azure 真实上限是 10 分钟音频；单条字幕远不触顶，取保守字符值。 */
const AZURE_TTS_MAX_CHARS = 3000;
/** ElevenLabs 按模型 5k–40k 不等；取 v3 下限口径保守通用。 */
const ELEVENLABS_TTS_MAX_CHARS = 5000;
/**
 * 豆包接口文档未明示上限（错误码 40402003 存在）；2026-07 实测 10000 字符
 * 不被前置拒绝（长文本合成耗时成为实际约束，必撞请求超时）。单条字幕远不
 * 触顶，取保守值兼作超时防线。
 */
const VOLC_TTS_MAX_CHARS = 1000;

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
    // 与 Azure 同一 Neural 音色命名体系，共用微软语音库文档。
    docsUrl:
      'https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts',
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
  {
    id: TTS_AZURE_SPEECH,
    name: 'Azure Speech',
    shortName: 'Azure',
    isBuiltin: true,
    icon: '🔷',
    // 品牌型硬单例：region + subscription key 凭据，可选 endpoint 覆盖主权云。
    voiceListMode: 'label', // voices/list 全量 700+，仅回填名称不替换清单
    docsUrl:
      'https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts',
    capabilities: {
      speedControl: 'ssml', // SSML prosody rate（对齐引擎 ssml 分支首个实现者）
      maxCharsPerRequest: AZURE_TTS_MAX_CHARS,
      concurrency: 2, // F0 免费层并发配额低，保守默认
    },
    fields: [
      {
        // Speech 服务可用区域固定枚举（国际云；世纪互联主权云走 endpoint 覆盖）。
        key: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        defaultValue: 'eastasia',
        // 按字母序排列（配合可搜索下拉快速定位）。
        options: [
          'australiaeast',
          'brazilsouth',
          'canadacentral',
          'centralindia',
          'centralus',
          'eastasia',
          'eastus',
          'eastus2',
          'francecentral',
          'germanywestcentral',
          'japaneast',
          'japanwest',
          'koreacentral',
          'northcentralus',
          'northeurope',
          'norwayeast',
          'qatarcentral',
          'southafricanorth',
          'southcentralus',
          'southeastasia',
          'swedencentral',
          'switzerlandnorth',
          'switzerlandwest',
          'uaenorth',
          'uksouth',
          'westcentralus',
          'westeurope',
          'westus',
          'westus2',
          'westus3',
        ],
        tips: 'ttsAzureRegionTips',
        placeholder: 'eastasia',
      },
      {
        key: 'apiKey',
        label: 'Subscription Key',
        type: 'password',
        required: true,
        tips: 'ttsAzureKeyTips',
        placeholder: 'phTtsApiKey',
      },
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'url',
        required: false,
        tips: 'ttsAzureEndpointTips',
        placeholder: 'https://eastasia.tts.speech.microsoft.com',
      },
      {
        // 微软 Neural 音色名（与 Edge 同一命名体系），默认中英常用集。
        key: 'voices',
        label: 'ttsVoices',
        type: 'text',
        required: true,
        defaultValue:
          'zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural, zh-CN-YunyangNeural, zh-CN-XiaoyiNeural, en-US-AriaNeural, en-US-GuyNeural, en-US-JennyNeural',
        tips: 'ttsVoicesAzureTips',
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
    id: TTS_VOLCENGINE,
    name: '火山引擎 豆包语音合成',
    shortName: '豆包语音',
    isBuiltin: true,
    icon: '🌋',
    iconImg: '/images/providers/volcengine-color.svg',
    // 品牌型硬单例：新版「豆包语音」控制台单 API Key（与豆包听写 ASR 同 Key 体系）。
    // 音色列表 API 属控制台 OpenAPI（AK/SK 签名体系），与语音 API Key 不通 → 不做在线拉取。
    docsUrl: 'https://www.volcengine.com/docs/6561/1257544',
    capabilities: {
      speedControl: 'native', // audio_params.speech_rate [-50,100] ↔ 倍速 [0.5,2.0]
      clone: true, // 声音复刻 2.0（S_ 音色 + seed-icl-2.0 资源路由）
      maxCharsPerRequest: VOLC_TTS_MAX_CHARS,
      concurrency: 2, // 字符版并发上限保守默认
    },
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'ttsVolcKeyTips',
        placeholder: 'phTtsApiKey',
      },
      {
        // 资源版本决定可用音色集与计费商品（2.0 音色配 seed-tts-2.0、
        // 1.0 音色（mars/moon 系列）配 seed-tts-1.0），错配报 55000000。
        // S_ 克隆音色由合成层自动路由 seed-icl-2.0，不占本配置。
        key: 'resourceId',
        label: 'ttsVolcResource',
        type: 'select',
        required: true,
        defaultValue: 'seed-tts-2.0',
        options: ['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr'],
        tips: 'ttsVolcResourceTips',
      },
      {
        // 2.0 通用音色（*_uranus_bigtts），中英混合、男女均衡预填。
        key: 'voices',
        label: 'ttsVoices',
        type: 'text',
        required: true,
        defaultValue:
          'zh_female_shuangkuaisisi_uranus_bigtts, zh_female_xiaohe_uranus_bigtts, zh_female_vv_uranus_bigtts, zh_male_m191_uranus_bigtts, zh_male_ruyayichen_uranus_bigtts',
        tips: 'ttsVoicesVolcTips',
      },
      {
        // 声音复刻训练凭据（可选）：训练接口走旧版双凭据（X-Api-App-Key +
        // X-Api-Access-Key），与合成单 Key 并存；不参与就绪判定。
        key: 'appId',
        label: 'ttsVolcAppId',
        type: 'text',
        required: false,
        tips: 'ttsVolcAppIdTips',
      },
      {
        key: 'accessToken',
        label: 'ttsVolcAccessToken',
        type: 'password',
        required: false,
        tips: 'ttsVolcAccessTokenTips',
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
    id: TTS_ELEVENLABS,
    name: 'ElevenLabs',
    isBuiltin: true,
    icon: '🎙️',
    // 品牌型硬单例：xi-api-key 凭据；国内需网络代理直连。
    voiceListMode: 'replace', // GET /v1/voices 账号音色少，整体替换 + 名称映射
    docsUrl: 'https://elevenlabs.io/app/voice-library',
    capabilities: {
      speedControl: 'native', // voice_settings.speed（provider 内 clamp [0.7,1.2]）
      clone: true,
      maxCharsPerRequest: ELEVENLABS_TTS_MAX_CHARS,
      concurrency: 2,
    },
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'ttsElevenKeyTips',
        placeholder: 'phTtsApiKey',
      },
      {
        key: 'model',
        label: 'Model ID',
        type: 'text',
        required: true,
        defaultValue: 'eleven_multilingual_v2',
        tips: 'ttsElevenModelTips',
      },
      {
        // voice_id 清单：预填官方 premade 通用款（Sarah/George/Adam/Daniel/
        // Charlotte，2026-07 实测免费账号 API 可用；Rachel/Aria 已转 library
        // 音色、免费层 402）。自有/克隆音色到 dashboard ▸ Voices 复制 id 追加。
        key: 'voices',
        label: 'ttsVoices',
        type: 'text',
        required: true,
        defaultValue:
          'EXAVITQu4vr4xnSDxMaL, JBFqnCBsd6RMkjVDRZzb, pNInz6obpgDQGcFmaJgB, onwK4e9ZLuTAKqWW03F9, cgSgspJ2msm6clMCkdW9',
        tips: 'ttsVoicesElevenTips',
      },
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: false,
        defaultValue: 'https://api.elevenlabs.io/v1',
        tips: 'ttsElevenApiUrlTips',
        placeholder: 'https://api.elevenlabs.io/v1',
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
 * 内置 premade 音色 id → 名称映射（ElevenLabs 默认预填集合，2026-07 实测
 * 免费账号可用）：实例未拉取过账号音色时的展示兜底。
 */
export const ELEVENLABS_PREMADE_VOICE_LABELS: Record<string, string> = {
  EXAVITQu4vr4xnSDxMaL: 'Sarah',
  JBFqnCBsd6RMkjVDRZzb: 'George',
  pNInz6obpgDQGcFmaJgB: 'Adam',
  onwK4e9ZLuTAKqWW03F9: 'Daniel',
  cgSgspJ2msm6clMCkdW9: 'Charlotte',
};

/**
 * 豆包 2.0 音色目录（voice_type → 中文名，官方音色列表口径）：
 * 无在线拉取通道（音色列表属控制台 OpenAPI 签名体系）→ 静态目录同时
 * 承担「标签/下拉按名称展示」与「录入自动补全」两个用途。
 * 只收 2.0（*_uranus_bigtts，与默认资源 seed-tts-2.0 匹配；2026-07 逐一
 * 真机验证可合成）；1.0 音色数百款不内置，走「音色文档」外链复制。
 */
export const VOLC_TTS_VOICE_LABELS: Record<string, string> = {
  zh_female_shuangkuaisisi_uranus_bigtts: '爽快思思 2.0',
  zh_female_xiaohe_uranus_bigtts: '小何 2.0',
  zh_female_vv_uranus_bigtts: 'Vivi 2.0',
  zh_female_cancan_uranus_bigtts: '知性灿灿 2.0',
  zh_female_qingxinnvsheng_uranus_bigtts: '清新女声 2.0',
  zh_female_linjianvhai_uranus_bigtts: '邻家女孩 2.0',
  zh_female_tianmeixiaoyuan_uranus_bigtts: '甜美小源 2.0',
  zh_female_tianmeitaozi_uranus_bigtts: '甜美桃子 2.0',
  zh_female_meilinvyou_uranus_bigtts: '魅力女友 2.0',
  zh_female_liuchangnv_uranus_bigtts: '流畅女声 2.0',
  zh_female_mizai_uranus_bigtts: '黑猫侦探社咪仔 2.0',
  zh_male_m191_uranus_bigtts: '云舟 2.0',
  zh_male_ruyayichen_uranus_bigtts: '儒雅逸辰 2.0',
  zh_male_taocheng_uranus_bigtts: '小天 2.0',
  zh_male_liufei_uranus_bigtts: '刘飞 2.0',
  zh_male_shaonianzixin_uranus_bigtts: '少年梓辛 2.0',
  zh_male_sunwukong_uranus_bigtts: '猴哥 2.0',
  zh_male_dayi_uranus_bigtts: '大壹 2.0',
  en_male_tim_uranus_bigtts: 'Tim 2.0（仅英文）',
};

/** 按类型取内置音色名映射（无在线拉取或未拉取时的展示兜底）。 */
const BUILTIN_VOICE_LABELS_BY_TYPE: Record<string, Record<string, string>> = {
  [TTS_ELEVENLABS]: ELEVENLABS_PREMADE_VOICE_LABELS,
  [TTS_VOLCENGINE]: VOLC_TTS_VOICE_LABELS,
};

/** 类型的内置音色名映射（配置面板标签展示与录入补全的兜底源）。 */
export function getBuiltinTtsVoiceLabels(
  typeId: string | undefined,
): Record<string, string> {
  return BUILTIN_VOICE_LABELS_BY_TYPE[typeId ?? ''] ?? {};
}

/**
 * 解析实例的音色显示名映射（`voiceLabels`：JSON 字符串或对象，id → 名称）。
 * ElevenLabs 等 voice_id 不可读的服务商用「拉取音色」回填；解析失败返回 {}。
 */
export function parseTtsVoiceLabels(
  provider: (Partial<TtsProvider> & { voiceLabels?: unknown }) | undefined,
): Record<string, string> {
  const raw = provider?.voiceLabels;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** 音色显示名：实例映射 → 内置映射（按类型查表）→ 原 id。 */
export function resolveTtsVoiceLabel(
  provider: (Partial<TtsProvider> & { voiceLabels?: unknown }) | undefined,
  voiceId: string,
): string {
  return (
    parseTtsVoiceLabels(provider)[voiceId] ??
    BUILTIN_VOICE_LABELS_BY_TYPE[provider?.type ?? '']?.[voiceId] ??
    voiceId
  );
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
