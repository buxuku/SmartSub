import type { ProviderField } from './provider';

/**
 * 云端听写（在线 ASR）服务商类型定义。
 *
 * 复用翻译服务商的多实例信用凭据模型（见 types/provider.ts）：
 * - `AsrProviderType` 描述某一类云 ASR 服务（首个为 OpenAI 兼容），驱动配置表单渲染；
 * - `AsrProvider` 是用户配置的实例（含凭据 + 模型清单），持久化在 store.asrProviders；
 * - 转写时由「单一云引擎适配器」按实例 `type` 分发到具体 service 实现（ASR_TRANSCRIBER_MAP）。
 *
 * 纯类型/常量（不依赖 electron / fs），main、renderer、test:engines 均可直接引入。
 */
export type AsrProviderField = ProviderField;

/**
 * 服务商类型声明的音频上传约束（各家上限差异巨大：OpenAI 25MB、火山 base64 膨胀、
 * 千问 10MB/5min…）。云引擎按声明取值；未声明的项回落全局默认（见 resolveAudioLimits）。
 */
export type AsrAudioLimits = {
  /** 单请求最大上传字节数（按压缩/编码前的本地文件体积计）。 */
  maxUploadBytes?: number;
  /** 超限切片时单切片最长时长（秒）。 */
  maxChunkSeconds?: number;
};

export type AsrProviderType = {
  id: string;
  name: string;
  /** 侧栏等窄空间用的品牌短名（如「腾讯云」）；缺省回落 name。 */
  shortName?: string;
  fields: AsrProviderField[];
  isBuiltin?: boolean;
  icon?: string;
  iconImg?: string;
  /**
   * 是否允许同类型配置多个实例。
   * - 协议型（如 OpenAI 兼容）：`true`——同一协议对应多家 vendor / 多个 base URL，需多实例。
   * - 品牌型（如 ElevenLabs / Deepgram）：留空（falsy）——固定单一服务端，硬单例即可。
   * 仅影响配置面板呈现（多实例可「添加实例」；单例「配置」一个、封顶 1），不改后端分发。
   */
  multiInstance?: boolean;
  /** 音频上传约束声明；未声明 = 沿用云引擎全局默认。 */
  audioLimits?: AsrAudioLimits;
};

/** 用户配置的云 ASR 服务商实例（多实例）。type 指向 AsrProviderType.id。 */
export type AsrProvider = {
  id: string;
  name: string;
  type: string;
  /**
   * 来源预设 id（如 'openai' / 'groq'）：由预设侧栏槽位物化的实例带此标记，
   * 槽位绑定不随 URL 改动漂移；自定义实例与历史实例无此字段（后者按 URL 认领）。
   */
  presetId?: string;
  [key: string]: any;
};

/** 云 ASR 服务商类型 id。 */
export const ASR_OPENAI_COMPATIBLE = 'openaiCompatible';
export const ASR_ELEVENLABS = 'elevenlabs';
export const ASR_DEEPGRAM = 'deepgram';
export const ASR_VOLCENGINE = 'volcengine';
export const ASR_TENCENT = 'tencent';
export const ASR_ALIYUN = 'aliyun';
export const ASR_XFYUN = 'xfyun';
export const ASR_GLADIA = 'gladia';

/**
 * 火山豆包极速版：官方音频上限 2h/100MB，但 base64 进 JSON 体膨胀 ×4/3 且整体驻留内存，
 * 保守取 16MB（base64 后 ≈21.3MB）。切片是未压缩 WAV 直传（16kHz 单声道 ≈1.92MB/min），
 * 480s ≈15.4MB 稳落 16MB 内（全局默认 600s ≈18.4MB 会超）。
 */
const VOLC_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const VOLC_MAX_CHUNK_SECONDS = 480;

/**
 * 腾讯极速版：官方双上限「请求体 ≤100MB 且时长 ≤2 小时」，而引擎切片判定只看字节
 * （prepareCloudAudio 无时长判定）。压缩产物为 32kbps mp3（≈0.24MB/min），若按 100MB
 * 声明可装 ≈7h 音频、会撞时长上限被拒；取 24MB ≈100min mp3 < 2h（约 17% 余量），
 * 以字节上限间接钳住时长。原始 WAV（1.92MB/min）≤24MB 时 ≈12.5min，更远低于上限。
 * 切片不声明，回落全局 600s（WAV ≈18.4MB，双双达标）。若调整压缩码率需联动复核此值。
 */
const TENCENT_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/**
 * 阿里云 NLS 录音文件识别极速版：官方双上限与腾讯同为「≤100MB 且 ≤2 小时」，
 * 引擎切片判定同样只看字节——取 24MB 与 TENCENT_MAX_UPLOAD_BYTES 同理同值
 * （32kbps mp3 ≈0.24MB/min，24MB≈100min<2h 留 17% 余量；600s WAV 切片 ≈18.4MB 达标）。
 * 若调整压缩码率需与腾讯常量联动复核。
 */
const ALIYUN_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/**
 * 腾讯极速版「模型档位」：identification 语言不在此选择——engine_type 由
 * 「档位 + 任务原语言」在转写时映射（见 tencentUtils.resolveTencentEngineType）。
 * - standard 普通版：单语种引擎（16k_zh / 16k_en / 16k_ja …），免费并发 20；
 * - large 大模型版：16k_zh_en（中英粤+方言）/ 16k_multi_lang（15 语种），
 *   识别更强、单价更高、免费并发仅 5。
 * 历史存量若存有原始 engine_type（16k_*）仍原样透传，不受档位化影响。
 */
const TENCENT_MODEL_TIERS = ['standard', 'large'];

/**
 * 讯飞「录音文件转写大模型」：官方双上限「500MB 且 ≤5 小时」，引擎切片判定只看字节。
 * 压缩产物 32kbps mp3 ≈0.24MB/min，若按 500MB 声明可装 ≈34h、必撞 5h 时长上限；
 * 取 48MB ≈ 3.3h mp3 间接钳制时长——字幕场景绝大多数视频整文件单订单转写、不切片
 * （讯飞官方也建议转写 5 分钟以上长音频，与细切片相性差）。切片时长不声明回落全局 600s
 * （WAV 切片 ≈18.4MB 达标）。若调整压缩码率需与腾讯/阿里常量联动复核。
 */
const XFYUN_MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

/**
 * 讯飞「语种档位」（models 承载，语义对齐腾讯档位模式；识别语言免切自动，
 * 任务原语言仅做上传前守卫，见 xfyunUtils.resolveXfyunLanguageSupport）：
 * - autodialect（默认）：中英 + 202 种方言免切识别，开通服务即用；
 * - autominor：37 语种免切识别，需联系讯飞人工对接单独开通。
 */
const XFYUN_LANGUAGE_TIERS = ['autodialect', 'autominor'];

/**
 * Gladia：官方双上限「1GB 且 ≤135 分钟」（标准档），引擎切片判定只看字节。
 * 压缩产物 32kbps mp3 ≈0.24MB/min，若按 1GB 声明可装 ≈70h、必撞 135min 时长上限；
 * 取 28MB ≈ 2h mp3 间接钳制时长（~11% 余量）。切片时长不声明回落全局 600s
 * （WAV 切片 ≈18.4MB 达标）。若调整压缩码率需与腾讯/阿里/讯飞常量联动复核。
 */
const GLADIA_MAX_UPLOAD_BYTES = 28 * 1024 * 1024;

/**
 * Gladia「模型档位」（识别语言免切自动，任务原语言仅做上传前守卫）：
 * - solaria-1（默认）：全语种档，100+ 语言（含 42 家独有）+ 自动检测 + code-switching；
 * - solaria-3（2026-06 发布）：欧语实录特化档（英法德西意），嘈杂/多说话人实录更强，
 *   干净朗读与小语种反不如 solaria-1，勿作默认。
 */
const GLADIA_MODELS = ['solaria-1', 'solaria-3'];

export const ASR_PROVIDER_TYPES: AsrProviderType[] = [
  {
    id: ASR_OPENAI_COMPATIBLE,
    name: 'OpenAI Compatible',
    isBuiltin: true,
    icon: '🎙️',
    // 协议型：可对接 OpenAI / Groq / 硅基流动 等多家兼容端点，允许多实例。
    multiInstance: true,
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        defaultValue: 'https://api.openai.com/v1',
        tips: 'asrApiUrlTips',
        placeholder: 'https://api.openai.com/v1',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'asrApiKeyTips',
        placeholder: 'phAsrApiKey',
      },
      {
        // 自由型模型清单（各兼容端点模型名不可枚举）：UI 用标签式录入，回车成标签。
        key: 'models',
        label: 'asrModels',
        type: 'text',
        required: true,
        defaultValue: 'whisper-1',
        tips: 'asrModelsTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_ELEVENLABS,
    name: 'ElevenLabs Scribe',
    shortName: 'ElevenLabs',
    isBuiltin: true,
    icon: '🗣️',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'asrElevenApiKeyTips',
        placeholder: 'phElevenApiKey',
      },
      {
        // 枚举型模型清单（勾选，不做自由文本）：scribe_v1 已废弃（官方 2026-07 移除），默认 v2。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: ['scribe_v2', 'scribe_v1'],
        required: true,
        defaultValue: 'scribe_v2',
        tips: 'asrModelsElevenTips',
      },
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: false,
        defaultValue: 'https://api.elevenlabs.io/v1',
        tips: 'asrApiUrlElevenTips',
        placeholder: 'https://api.elevenlabs.io/v1',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_DEEPGRAM,
    name: 'Deepgram',
    isBuiltin: true,
    icon: '🐬',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'asrDeepgramApiKeyTips',
        placeholder: 'phDeepgramApiKey',
      },
      {
        // 枚举型模型清单（勾选，不做自由文本）；nova-3 语种较少，默认 nova-2 保多语覆盖。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: ['nova-2', 'nova-3'],
        required: true,
        defaultValue: 'nova-2',
        tips: 'asrModelsDeepgramTips',
      },
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: false,
        defaultValue: 'https://api.deepgram.com/v1',
        tips: 'asrApiUrlDeepgramTips',
        placeholder: 'https://api.deepgram.com/v1',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_VOLCENGINE,
    name: '火山引擎 豆包听写',
    shortName: '豆包听写',
    isBuiltin: true,
    icon: '🌋',
    iconImg: '/images/providers/volcengine-color.svg',
    // 品牌型硬单例：固定官方端点；base64 直传 → 声明保守上传上限与切片时长（详见常量注释）。
    audioLimits: {
      maxUploadBytes: VOLC_MAX_UPLOAD_BYTES,
      maxChunkSeconds: VOLC_MAX_CHUNK_SECONDS,
    },
    fields: [
      {
        // 新版语音控制台「API Key 管理」签发的 API Key（单 X-Api-Key 鉴权；不支持旧版两件套）。
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'asrVolcApiKeyTips',
        placeholder: 'phVolcApiKey',
      },
      {
        // 单一固定模型：UI 只读展示，不可编辑。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: ['bigmodel'],
        required: true,
        defaultValue: 'bigmodel',
        tips: 'asrModelsVolcTips',
      },
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: false,
        defaultValue: 'https://openspeech.bytedance.com',
        tips: 'asrApiUrlVolcTips',
        placeholder: 'https://openspeech.bytedance.com',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_TENCENT,
    name: '腾讯云 录音识别极速版',
    shortName: '腾讯云',
    isBuiltin: true,
    icon: '🐧',
    iconImg: '/images/providers/tencentcloud-color.svg',
    // 品牌型硬单例。端点固定 asr.cloud.tencent.com（签名原文绑定 Host，不开放自定义）。
    // 双上限 100MB/2h 经 24MB 字节上限间接钳制（详见常量注释）。
    audioLimits: {
      maxUploadBytes: TENCENT_MAX_UPLOAD_BYTES,
    },
    fields: [
      {
        // 语音识别控制台「API 密钥管理」三件套之一（appid 进请求路径参与签名）。
        key: 'appid',
        label: 'AppID',
        type: 'text',
        required: true,
        tips: 'asrTencentAppidTips',
        placeholder: 'phTencentAppid',
      },
      {
        key: 'secretId',
        label: 'SecretID',
        type: 'password',
        required: true,
        tips: 'asrTencentSecretIdTips',
        placeholder: 'phTencentSecretId',
      },
      {
        key: 'secretKey',
        label: 'SecretKey',
        type: 'password',
        required: true,
        tips: 'asrTencentSecretKeyTips',
        placeholder: 'phTencentSecretKey',
      },
      {
        // 档位点选（识别语言跟随任务原语言自动映射 engine_type，无需在此选语言）。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: TENCENT_MODEL_TIERS,
        required: true,
        defaultValue: 'standard',
        tips: 'asrModelsTencentTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_ALIYUN,
    name: '阿里云 录音识别极速版',
    shortName: '阿里云',
    isBuiltin: true,
    icon: '☁️',
    iconImg: '/images/providers/alibabacloud.svg',
    // 品牌型硬单例（同豆包/腾讯）。识别语种绑定 NLS 控制台项目（appkey）而非请求参数，
    // 换语种在控制台改项目配置即可（普通话模型本身可识别中英混合，覆盖主流场景）。
    // 端点固定（识别 nls-gateway / 取号 nls-meta，模块内常量），不开放自定义。
    audioLimits: {
      maxUploadBytes: ALIYUN_MAX_UPLOAD_BYTES,
    },
    fields: [
      {
        // RAM 访问控制签发的 AccessKey 两件套（用于 CreateToken 取临时令牌，两段式鉴权）。
        key: 'accessKeyId',
        label: 'AccessKey ID',
        type: 'password',
        required: true,
        tips: 'asrAliyunAccessKeyIdTips',
        placeholder: 'phAliyunAccessKeyId',
      },
      {
        key: 'accessKeySecret',
        label: 'AccessKey Secret',
        type: 'password',
        required: true,
        tips: 'asrAliyunAccessKeySecretTips',
        placeholder: 'phAliyunAccessKeySecret',
      },
      {
        // NLS 控制台「全部项目」创建项目后获得；识别语种在项目功能配置中设定。
        key: 'appkey',
        label: 'Appkey',
        type: 'text',
        required: true,
        tips: 'asrAliyunAppkeyTips',
        placeholder: 'phAliyunAppkey',
      },
      {
        // 单一固定模型（接口无模型参数，模型语义由 appkey 项目配置吸收）：UI 只读展示。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: ['flash'],
        required: true,
        defaultValue: 'flash',
        tips: 'asrModelsAliyunTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 120,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_XFYUN,
    name: '讯飞 录音文件转写大模型',
    shortName: '讯飞听写',
    isBuiltin: true,
    icon: '🎤',
    iconImg: '/images/providers/spark-color.svg',
    // 品牌型硬单例。端点固定 office-api-ist-dx.iflyaisol.com（模块内常量），不开放自定义。
    // 异步订单制（上传→轮询），500MB/5h 经 48MB 字节上限间接钳制（详见常量注释）。
    audioLimits: {
      maxUploadBytes: XFYUN_MAX_UPLOAD_BYTES,
    },
    fields: [
      {
        // 讯飞开放平台控制台「服务接口认证信息」三件套：APPID / APIKey / APISecret
        // （APIKey/APISecret 对应转写 API 的 accessKeyId/accessKeySecret，实测确认）。
        key: 'appid',
        label: 'APPID',
        type: 'text',
        required: true,
        tips: 'asrXfyunAppidTips',
        placeholder: 'phXfyunAppid',
      },
      {
        key: 'apiKey',
        label: 'APIKey',
        type: 'password',
        required: true,
        tips: 'asrXfyunApiKeyTips',
        placeholder: 'phXfyunApiKey',
      },
      {
        key: 'apiSecret',
        label: 'APISecret',
        type: 'password',
        required: true,
        tips: 'asrXfyunApiSecretTips',
        placeholder: 'phXfyunApiSecret',
      },
      {
        // 语种档位点选（识别语言免切自动；任务原语言仅上传前守卫，不上行）。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: XFYUN_LANGUAGE_TIERS,
        required: true,
        defaultValue: 'autodialect',
        tips: 'asrModelsXfyunTips',
      },
      {
        // 异步订单制：单次 HTTP 超时（上传大文件比同步各家更久），默认放宽到 300s；
        // 轮询节奏与总等待上限由 service 内部策略驱动，不受此值控制。
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 300,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
  {
    id: ASR_GLADIA,
    name: 'Gladia',
    isBuiltin: true,
    icon: '🎧',
    // 品牌型硬单例。异步任务制（上传→建任务→轮询），x-gladia-key 头鉴权、无签名。
    // 1GB/135min 经 28MB 字节上限间接钳制（详见常量注释）。
    audioLimits: {
      maxUploadBytes: GLADIA_MAX_UPLOAD_BYTES,
    },
    fields: [
      {
        // app.gladia.io 控制台「API Keys」签发（免费档每月 10h，免费档音频会用于模型训练）。
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'asrGladiaApiKeyTips',
        placeholder: 'phGladiaApiKey',
      },
      {
        // 模型档位点选（识别语言免切自动；任务原语言仅上传前守卫，命中支持清单才上行）。
        key: 'models',
        label: 'asrModels',
        type: 'select',
        options: GLADIA_MODELS,
        required: true,
        defaultValue: 'solaria-1',
        tips: 'asrModelsGladiaTips',
      },
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: false,
        defaultValue: 'https://api.gladia.io',
        tips: 'asrApiUrlGladiaTips',
        placeholder: 'https://api.gladia.io',
      },
      {
        // 异步任务制：单次 HTTP 超时（上传大文件比同步各家更久），默认放宽到 300s；
        // 轮询节奏与总等待上限由 service 内部策略驱动，不受此值控制。
        key: 'requestTimeoutSec',
        label: 'asrRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 300,
        step: 10,
        tips: 'asrRequestTimeoutTips',
      },
      {
        key: 'concurrency',
        label: 'asrConcurrency',
        type: 'number',
        required: false,
        defaultValue: 4,
        step: 1,
        tips: 'asrConcurrencyTips',
      },
      {
        key: 'requestInterval',
        label: 'requestInterval',
        type: 'number',
        required: false,
        defaultValue: 0,
        step: 0.1,
        tips: 'asrRequestIntervalTips',
      },
    ],
  },
];

/** 按 id 取服务商类型定义。 */
export function getAsrProviderType(
  type: string | undefined,
): AsrProviderType | undefined {
  if (!type) return undefined;
  return ASR_PROVIDER_TYPES.find((t) => t.id === type);
}

/**
 * 解析某服务商类型的生效音频上传约束：类型声明值优先，未声明回落调用方给定默认
 * （云引擎传入全局 CLOUD_MAX_* 常量）。纯函数，defaults 由调用方注入以保持本模块零依赖。
 */
export function resolveAudioLimits(
  type: AsrProviderType | undefined,
  defaults: { maxUploadBytes: number; maxChunkSeconds: number },
): { maxUploadBytes: number; maxChunkSeconds: number } {
  return {
    maxUploadBytes:
      type?.audioLimits?.maxUploadBytes ?? defaults.maxUploadBytes,
    maxChunkSeconds:
      type?.audioLimits?.maxChunkSeconds ?? defaults.maxChunkSeconds,
  };
}

/**
 * 「命名预设」：协议型（如 OpenAI 兼容）下的常见 vendor，一键预填 base URL + 模型。
 * 预设**只覆盖字段值**（apiUrl / models …），实例 `type` 不变——后端分发与凭据校验完全不受影响。
 */
export interface AsrProviderPreset {
  id: string;
  name: string;
  icon?: string;
  /** 覆盖到实例的字段值（键对应 AsrProviderField.key）。 */
  values: Record<string, string>;
}

/**
 * 各服务商类型的命名预设（键 = `AsrProviderType.id`）。
 * 仅协议型需要（同协议对接多家 vendor）；品牌型固定单端、无预设。
 * base URL / 模型名以各家官方 OpenAI 兼容转写端点为准（Groq / 硅基流动 已核实）。
 */
export const ASR_PROVIDER_PRESETS: Record<string, AsrProviderPreset[]> = {
  [ASR_OPENAI_COMPATIBLE]: [
    {
      id: 'openai',
      name: 'OpenAI',
      icon: '🤖',
      values: {
        apiUrl: 'https://api.openai.com/v1',
        models: 'whisper-1, gpt-4o-transcribe',
      },
    },
    {
      id: 'groq',
      name: 'Groq',
      icon: '⚡',
      values: {
        apiUrl: 'https://api.groq.com/openai/v1',
        models: 'whisper-large-v3-turbo, whisper-large-v3',
      },
    },
    {
      id: 'siliconflow',
      name: 'SiliconFlow 硅基流动',
      icon: '🧊',
      values: {
        apiUrl: 'https://api.siliconflow.cn/v1',
        models: 'FunAudioLLM/SenseVoiceSmall',
      },
    },
  ],
};

/** 取某类型的命名预设清单（无则空数组）。 */
export function getAsrPresetsForType(
  typeId: string | undefined,
): AsrProviderPreset[] {
  if (!typeId) return [];
  return ASR_PROVIDER_PRESETS[typeId] ?? [];
}

/**
 * 由「类型 + 可选预设」构造新实例：先铺类型字段默认值，再用预设 `values` 覆盖。
 * 无预设时等价「自定义」（仅类型默认）。纯函数——面板与 `test:engines` 复用；
 * `idFactory` 便于单测注入确定 id。
 */
export function buildInstanceFromPreset(
  type: AsrProviderType,
  preset?: AsrProviderPreset,
  idFactory: () => string = () => `asr_${Date.now()}`,
): AsrProvider {
  const instance: AsrProvider = {
    id: idFactory(),
    name: preset?.name ?? type.name,
    type: type.id,
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

/** 归一化端点 URL 供预设匹配：去空白、去尾斜杠、小写。 */
function normalizeEndpoint(url: unknown): string {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 按实例 `apiUrl` 反查其来源预设（实例行借此展示预设图标/身份）：
 * 与某预设 `values.apiUrl` 归一化相等即命中；自定义或改过 URL 的实例返回 undefined。
 */
export function matchAsrPreset(
  instance: AsrProvider,
  presets: AsrProviderPreset[] = getAsrPresetsForType(instance.type),
): AsrProviderPreset | undefined {
  const url = normalizeEndpoint(instance.apiUrl);
  if (!url) return undefined;
  return presets.find((p) => normalizeEndpoint(p.values.apiUrl) === url);
}

/**
 * 实例去重命名：`base` 未被占用则原样返回，否则追加序号
 * （`OpenAI` → `OpenAI 2` → `OpenAI 3`…），避免同预设多次添加得到无法区分的同名实例。
 */
export function nextInstanceName(
  existing: Pick<AsrProvider, 'name'>[] | undefined,
  base: string,
): string {
  const names = new Set((existing ?? []).map((p) => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

// ── 左栏「云端听写」分组导航 ────────────────────────────────────────────────
//
// 每个条目 = 一张可直接填写的表单（零实例管理概念）：
// - 品牌型类型（ElevenLabs / 腾讯云 …）→ 一个条目；
// - 协议型类型（OpenAI 兼容）→ **每个预设一个固定槽位条目**（OpenAI / Groq / 硅基
//   流动，选中即表单，同品牌型），外加用户「添加自定义」产生的逐实例条目；
// - 类型下线的孤儿实例 → 按类型兜底一个条目（可查可删）。

/** 云视图 id 前缀：左栏云入口的视图 id 形如 `cloud:<typeId>[…]`。 */
export const CLOUD_VIEW_PREFIX = 'cloud:';

/** 品牌型/孤儿类型条目的视图 id。 */
export function cloudViewId(typeId: string): string {
  return `${CLOUD_VIEW_PREFIX}${typeId}`;
}

/** 协议型预设槽位条目的视图 id：`cloud:<typeId>:<presetId>`。 */
export function cloudPresetViewId(typeId: string, presetId: string): string {
  return `${CLOUD_VIEW_PREFIX}${typeId}:${presetId}`;
}

/** 协议型自定义实例条目的视图 id：`cloud:<typeId>:i:<instanceId>`。 */
export function cloudCustomViewId(typeId: string, instanceId: string): string {
  return `${CLOUD_VIEW_PREFIX}${typeId}:i:${instanceId}`;
}

/** 从任意云视图 id 提取类型 id（首段）；非云视图返回 null。 */
export function cloudViewTypeId(viewId: string | undefined): string | null {
  if (!viewId || !viewId.startsWith(CLOUD_VIEW_PREFIX)) return null;
  const typeId = viewId.slice(CLOUD_VIEW_PREFIX.length).split(':')[0];
  return typeId || null;
}

/** 左栏云组的一个条目（一条目 = 一张表单）。 */
export interface CloudEngineView {
  viewId: string;
  /** 条目形态：品牌单例 / 协议预设槽位 / 协议自定义实例 / 孤儿类型。 */
  kind: 'brand' | 'preset' | 'custom' | 'orphan';
  type: AsrProviderType;
  /** 侧栏显示名（brand=短名；preset=预设名；custom=实例名；orphan=类型 id）。 */
  label: string;
  icon?: string;
  iconImg?: string;
  /** kind='preset' 时的预设定义（图标 / 预填值）。 */
  preset?: AsrProviderPreset;
  /** 绑定实例：brand 单例 / preset 认领实例 / custom 实例；未物化或 orphan 时缺省。 */
  instance?: AsrProvider;
  /** kind='orphan' 时该下线类型的全部遗留实例。 */
  orphanInstances?: AsrProvider[];
  configured: boolean;
}

/**
 * 产出左栏「云端听写」组条目清单。纯函数，供 EngineModelTab 渲染与 test:engines 单测。
 *
 * 协议型的「槽位认领」规则（每槽至多一个实例）：
 * 1. 实例 `presetId` 显式指向该预设（新建槽位物化时打标，改 URL 不漂移）；
 * 2. 兼容历史：无 `presetId` 且名称与 URL 均与预设一致（改过名/URL 的历史实例
 *    视为自定义条目，保留用户身份）。
 * 未被认领的协议型实例逐个成为自定义条目，追加在该类型预设槽位之后。
 */
export function buildCloudViews(
  providers?: AsrProvider[],
  types: AsrProviderType[] = ASR_PROVIDER_TYPES,
  presetsByType: Record<string, AsrProviderPreset[]> = ASR_PROVIDER_PRESETS,
): CloudEngineView[] {
  const list = providers ?? [];
  const knownIds = new Set(types.map((t) => t.id));
  const views: CloudEngineView[] = [];

  for (const type of types) {
    const instances = list.filter((p) => p.type === type.id);

    if (!type.multiInstance) {
      const instance = instances[0];
      views.push({
        viewId: cloudViewId(type.id),
        kind: 'brand',
        type,
        label: type.shortName ?? type.name,
        icon: type.icon,
        iconImg: type.iconImg,
        instance,
        configured: instance ? isAsrProviderConfigured(instance, type) : false,
      });
      continue;
    }

    const presets = presetsByType[type.id] ?? [];
    const claimed = new Set<string>();
    for (const preset of presets) {
      const instance =
        instances.find((p) => !claimed.has(p.id) && p.presetId === preset.id) ??
        instances.find(
          (p) =>
            !claimed.has(p.id) &&
            p.presetId === undefined &&
            p.name === preset.name &&
            matchAsrPreset(p, presets)?.id === preset.id,
        );
      if (instance) claimed.add(instance.id);
      views.push({
        viewId: cloudPresetViewId(type.id, preset.id),
        kind: 'preset',
        type,
        label: preset.name,
        icon: preset.icon ?? type.icon,
        preset,
        instance,
        configured: instance ? isAsrProviderConfigured(instance, type) : false,
      });
    }
    for (const instance of instances) {
      if (claimed.has(instance.id)) continue;
      views.push({
        viewId: cloudCustomViewId(type.id, instance.id),
        kind: 'custom',
        type,
        label: instance.name,
        instance,
        configured: isAsrProviderConfigured(instance, type),
      });
    }
  }

  // 孤儿类型兜底：类型下线的遗留实例按类型成组追加末尾（可查可删，恒未配置）。
  const orphanByType = new Map<string, AsrProvider[]>();
  for (const p of list) {
    if (knownIds.has(p.type)) continue;
    const arr = orphanByType.get(p.type);
    if (arr) arr.push(p);
    else orphanByType.set(p.type, [p]);
  }
  orphanByType.forEach((orphanInstances, typeId) => {
    views.push({
      viewId: cloudViewId(typeId),
      kind: 'orphan',
      type: { id: typeId, name: typeId, fields: [] },
      label: typeId,
      orphanInstances,
      configured: false,
    });
  });
  return views;
}

/**
 * 历史遗留左栏选中值 `'cloud'`（旧单一云入口）的落点：首个「已配置」类型的
 * 云视图 id；无任何已配置实例则回落云组首个类型。恒有已知类型，必有返回值。
 */
export function resolveLegacyCloudView(
  providers?: AsrProvider[],
  types: AsrProviderType[] = ASR_PROVIDER_TYPES,
): string {
  const views = buildCloudViews(providers, types);
  const configured = views.find((v) => v.configured);
  return (configured ?? views[0]).viewId;
}

/**
 * 解析实例的可选模型清单：`models` 支持字符串（分隔符宽容：半/全角逗号、顿号、分号、换行）
 * 或数组，去空去重。空则返回 []（调用方据此判定「未配置模型」）。
 * UI 已改为标签/勾选录入（写回规范半角逗号），宽容分隔仅为兼容历史手输数据。
 */
export function parseAsrModels(
  provider: (Partial<AsrProvider> & { models?: unknown }) | undefined,
): string[] {
  const raw = provider?.models;
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
 * 就绪判定：实例所有「必填字段」均非空即视为已配置（含 models 至少一个）。
 * 与翻译服务商 isProviderConfigured 同口径，供 UI 分组与转写前守卫复用。
 */
export function isAsrProviderConfigured(
  provider: AsrProvider | undefined,
  type?: AsrProviderType,
): boolean {
  if (!provider) return false;
  const def = type ?? getAsrProviderType(provider.type);
  if (!def) return false;
  return def.fields
    .filter((f) => f.required)
    .every((f) => {
      if (f.key === 'models') return parseAsrModels(provider).length > 0;
      const v = provider[f.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
}
