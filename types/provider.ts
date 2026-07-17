export type ProviderField = {
  key: string;
  label: string;
  type:
    | 'text'
    | 'password'
    | 'textarea'
    | 'url'
    | 'number'
    | 'switch'
    | 'select'
    | 'chain';
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  step?: string | number;
  tips?: string;
  options?: string[];
};

export type ProviderType = {
  id: string;
  name: string;
  fields: ProviderField[];
  isBuiltin?: boolean;
  icon?: string;
  isAi?: boolean;
  iconImg?: string;
  /** 左列分组：free=免费起步，ai=AI 翻译，mt=传统机翻 */
  group?: 'free' | 'ai' | 'mt';
};

export type Provider = {
  id: string;
  name: string;
  type: string;
  isAi: boolean;
  [key: string]: any;
};

/** 结构化输出（response_format）模式 */
export type StructuredOutputMode = 'disabled' | 'json_object' | 'json_schema';

/**
 * 结构化输出模式优先级（能力从高到低）。
 * 运行时静默降级与「测试自动探测」共用此顺序：
 * json_schema 失败降到 json_object，再降到 disabled。
 */
export const STRUCTURED_OUTPUT_MODES: StructuredOutputMode[] = [
  'json_schema',
  'json_object',
  'disabled',
];

export type ParameterValue = string | number | boolean | object | any[];

export interface CustomParameterConfig {
  headerParameters: Record<string, ParameterValue>;
  bodyParameters: Record<string, ParameterValue>;
  configVersion: string;
  lastModified: number;
}

export interface ExtendedProvider extends Provider {
  customParameters?: CustomParameterConfig;
}

export interface ParameterDefinition {
  key: string;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'object' | 'array';
  category: 'core' | 'behavior' | 'response' | 'provider' | 'performance';
  required: boolean;
  defaultValue?: ParameterValue;
  validation?: ValidationRule;
  description: string;
  providerSupport: string[];
}

export interface ValidationRule {
  min?: number;
  max?: number;
  enum?: any[];
  pattern?: string;
  dependencies?: Record<string, any>;
}

export type ParameterCategory =
  | 'provider'
  | 'performance'
  | 'quality'
  | 'experimental';

export interface ProcessedParameters {
  headers: Record<string, string | number>;
  body: Record<string, any>;
  appliedParameters: string[];
  skippedParameters: string[];
  validationErrors: ValidationError[];
}

export interface ValidationError {
  key: string;
  type: 'type' | 'range' | 'format' | 'dependency' | 'system';
  message: string;
  suggestion?: string;
}

export interface ParameterTemplate {
  id: string;
  name: string;
  description: string;
  category: ParameterCategory;
  headerParameters: Record<string, ParameterValue>;
  bodyParameters: Record<string, ParameterValue>;
  modelCompatibility?: string[];
  useCase?: string;
  provider?: string;
}

export const defaultUserPrompt = '${content}';
export const TENCENT_DEFAULT_REQUEST_INTERVAL_SECONDS = 0.25;

/**
 * 历史版本的默认系统提示词，用于迁移时判断用户是否修改过
 * 每次修改 defaultSystemPrompt 时，将旧版本追加到此数组末尾
 */
const HISTORICAL_DEFAULT_PROMPTS_BEFORE_GLOSSARY: string[] = [
  `# Role: 资深翻译专家
您是一位经验丰富的字幕翻译专家,精通\${targetLanguage}的翻译,擅长将视频字幕译成流畅易懂的\${targetLanguage}。

# Attention:
在整个翻译过程中，您需要注意以下几点：

1. 保持每条字幕的独立性和完整性，不合并或拆分。
2. 使用口语化的\${targetLanguage}，避免过于书面化的表达，以符合字幕的特点。
3. 适当使用标点符号，如逗号、句号，甚至省略号，来增强语气和节奏感。
4. 确保专业术语的准确性，并且在上下文中保持一致性。

# 输出格式要求：
1. 您必须严格按照输入的JSON格式进行输出，保留原始的键（ID），仅翻译值的内容。
2. 不要添加任何额外的文本、注释或解释，只返回纯JSON。
3. 不要改变键值对的数量，确保输出的JSON对象与输入包含相同数量的键值对。
4. 确保输出是有效的JSON格式，不能有语法错误。

最后，您需要检查整个翻译是否流畅，是否有语法错误，以及是否忠实于原文意思。特别是要注意译文与原文之间的差异，比如英语中常用被动语态，而中文则更多使用主动语态，所以在翻译时可能会做一些调整，以适应\${targetLanguage}的表达习惯。

# Examples

Input:
{"0": "Welcome to China", "1": "China is a beautiful country"}

Output:
{"0": "欢迎来到中国", "1": "中国是一个美丽的国家"}
`,
];

const DEFAULT_SYSTEM_PROMPT_BEFORE_GLOSSARY = `# Role: 资深翻译专家
您是一位经验丰富的字幕翻译专家,精通\${sourceLanguage}的翻译,擅长将视频字幕译成流畅易懂的\${targetLanguage}。

# Attention:
在整个翻译过程中，您需要注意以下几点：

1. 保持每条字幕的独立性和完整性，不合并或拆分。
2. 使用口语化的\${targetLanguage}，避免过于书面化的表达，以符合字幕的特点。
3. 适当使用标点符号，如逗号、句号，甚至省略号，来增强语气和节奏感。
4. 确保专业术语的准确性，并且在上下文中保持一致性。

# 输出格式要求：
1. 您必须严格按照输入的JSON格式进行输出，保留原始的键（ID），仅翻译值的内容。
2. 不要添加任何额外的文本、注释或解释，只返回纯JSON。
3. 不要改变键值对的数量，确保输出的JSON对象与输入包含相同数量的键值对。
4. 确保输出是有效的JSON格式，不能有语法错误。

最后，您需要检查整个翻译是否流畅，是否有语法错误，以及是否忠实于原文意思。特别是要注意译文与原文之间的差异，比如英语中常用被动语态，而中文则更多使用主动语态，所以在翻译时可能会做一些调整，以适应\${targetLanguage}的表达习惯。

# Examples

Input:
{\"0\": \"Welcome to China\", \"1\": \"China is a beautiful country\"}

Output:
{\"0\": \"欢迎来到中国\", \"1\": \"中国是一个美丽的国家\"}
`;

/** v20 时代的默认提示词（含词库变量、无回显协议），迁移判定用 */
const DEFAULT_SYSTEM_PROMPT_BEFORE_ECHO =
  DEFAULT_SYSTEM_PROMPT_BEFORE_GLOSSARY.replace(
    '\n# 输出格式要求：',
    '\n\${glossary}\n\n# 输出格式要求：',
  );

// v3.4 及更早版本的默认提示词没有词库变量（provider v20 迁移）；
// v20 的默认提示词没有 src/tr 回显协议（provider v21 迁移）。
// 迁移只更新仍在使用旧默认值的服务商；用户自定义 prompt 保持不变。
export const HISTORICAL_DEFAULT_PROMPTS: string[] = [
  ...HISTORICAL_DEFAULT_PROMPTS_BEFORE_GLOSSARY,
  DEFAULT_SYSTEM_PROMPT_BEFORE_GLOSSARY,
  DEFAULT_SYSTEM_PROMPT_BEFORE_ECHO,
];

/**
 * 当前默认系统提示词：回显锚定协议（design D4/D9）。
 * 模型对每条字幕返回 {src: 原文回显, tr: 译文}，回显用于检测合并/滑移错位；
 * 配合按批次动态生成的 JSON Schema 在解码层面锁死条数。
 */
export const defaultSystemPrompt = `# Role: 资深翻译专家
您是一位经验丰富的字幕翻译专家,精通\${sourceLanguage}的翻译,擅长将视频字幕译成流畅易懂的\${targetLanguage}。

# Attention:
在整个翻译过程中，您需要注意以下几点：

1. 保持每条字幕的独立性和完整性，严禁合并或拆分条目。
2. 使用口语化的\${targetLanguage}，避免过于书面化的表达，以符合字幕的特点。
3. 适当使用标点符号，如逗号、句号，甚至省略号，来增强语气和节奏感。
4. 确保专业术语的准确性，并且在上下文中保持一致性。

\${glossary}

# 输出格式要求：
1. 输入是一个 JSON 对象，键是字幕 ID，值是该条字幕的原文。
2. 您必须返回一个 JSON 对象，键与输入完全一致（相同的 ID，相同的数量）。
3. 每个键的值是一个包含两个字段的对象：
   - "src"：逐字复制该条字幕的原文，不做任何修改。
   - "tr"：该条字幕的\${targetLanguage}译文。
4. 每条译文只对应该条原文：即使句子跨越多条字幕，也严禁把相邻条目合并翻译或移动内容。
5. 不要添加任何额外的文本、注释或解释，只返回纯JSON，且不能有语法错误。

最后，您需要检查整个翻译是否流畅，是否有语法错误，以及是否忠实于原文意思。特别是要注意译文与原文之间的差异，比如英语中常用被动语态，而中文则更多使用主动语态，所以在翻译时可能会做一些调整，以适应\${targetLanguage}的表达习惯。

# Examples

Input:
{"0": "Welcome to China", "1": "China is a beautiful country"}

Output:
{"0": {"src": "Welcome to China", "tr": "欢迎来到中国"}, "1": {"src": "China is a beautiful country", "tr": "中国是一个美丽的国家"}}
`;

/** 提示词是否包含 src/tr 回显协议约定（UI 用于提示自定义提示词用户更新，design D5） */
export function promptSupportsEchoAnchoring(prompt?: string): boolean {
  if (!prompt) return true; // 空值走默认提示词，天然支持
  return prompt.includes('"src"') && prompt.includes('"tr"');
}

// ============================================================
// 共享字段定义
// ============================================================

const FIELD_REQUEST_INTERVAL: ProviderField = {
  key: 'requestInterval',
  label: 'requestInterval',
  type: 'number',
  defaultValue: 0,
  step: 0.1,
  tips: 'requestIntervalTip',
  placeholder: 'phRequestInterval',
};

const tencentRequestIntervalField: ProviderField = {
  ...FIELD_REQUEST_INTERVAL,
  defaultValue: TENCENT_DEFAULT_REQUEST_INTERVAL_SECONDS,
};

const FIELD_SYSTEM_PROMPT: ProviderField = {
  key: 'systemPrompt',
  label: 'systemPrompt',
  type: 'textarea',
  tips: 'systemPromptTips',
  defaultValue: defaultSystemPrompt,
};

const FIELD_USER_PROMPT: ProviderField = {
  key: 'prompt',
  label: 'prompt',
  type: 'textarea',
  defaultValue: defaultUserPrompt,
  tips: 'userPromptTips',
};

const batchSizeField = (
  defaultValue: number = 1,
  tips: string = 'batchSizeTip',
): ProviderField => ({
  key: 'batchSize',
  label: 'Batch Size',
  type: 'number',
  defaultValue,
  tips,
  placeholder: 'phBatchSize',
});

const FIELD_BATCH_CONCURRENCY: ProviderField = {
  key: 'batchConcurrency',
  label: 'batchConcurrency',
  type: 'number',
  defaultValue: 1,
  tips: 'batchConcurrencyTip',
  placeholder: 'phBatchConcurrency',
};

const structuredOutputField = (
  defaultValue: string = 'json_object',
): ProviderField => ({
  key: 'structuredOutput',
  label: 'structuredOutput',
  type: 'select',
  required: false,
  defaultValue,
  options: ['disabled', 'json_object', 'json_schema'],
  tips: 'structuredOutputTips',
});

/** 回显锚定开关（design D4）：默认开启，可关闭以节省输出 token。 */
const FIELD_ECHO_ANCHORING: ProviderField = {
  key: 'echoAnchoring',
  label: 'echoAnchoring',
  type: 'switch',
  required: false,
  defaultValue: true,
  tips: 'echoAnchoringTips',
};

const aiCommonFields = (overrides?: {
  batchSize?: number;
  batchSizeTips?: string;
  structuredOutput?: string;
}): ProviderField[] => [
  FIELD_SYSTEM_PROMPT,
  FIELD_USER_PROMPT,
  structuredOutputField(overrides?.structuredOutput),
  FIELD_ECHO_ANCHORING,
  batchSizeField(overrides?.batchSize, overrides?.batchSizeTips),
  FIELD_BATCH_CONCURRENCY,
  FIELD_REQUEST_INTERVAL,
];

const apiBatchFields = (
  defaultBatchSize: number,
  batchSizeTips: string,
  requestIntervalField: ProviderField = FIELD_REQUEST_INTERVAL,
): ProviderField[] => [
  batchSizeField(defaultBatchSize, batchSizeTips),
  FIELD_BATCH_CONCURRENCY,
  requestIntervalField,
];

// ============================================================
// Provider 定义
// ============================================================

export const PROVIDER_TYPES: ProviderType[] = [
  {
    id: 'baidu',
    name: 'baidu',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🔤',
    iconImg: '/images/providers/baidu-color.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'APP ID',
        type: 'password',
        required: true,
        tips: 'baiduApiKeyTips',
        placeholder: 'phBaiduAppId',
      },
      {
        key: 'apiSecret',
        label: 'Secret Key',
        type: 'password',
        required: true,
        placeholder: 'phBaiduSecretKey',
      },
      ...apiBatchFields(18, 'batchSizeBaiduTips'),
    ],
  },
  {
    id: 'autoFree',
    name: 'autoFree',
    isBuiltin: true,
    isAi: false,
    group: 'free',
    icon: '🆓',
    iconImg: '/images/providers/free-auto.svg',
    fields: [
      {
        key: 'fallbackChain',
        label: 'fallbackChain',
        type: 'chain',
        required: false,
        defaultValue: 'bingFree,googleFree,deeplx',
        tips: 'fallbackChainTips',
      },
      {
        key: 'windowMaxRequests',
        label: 'windowMaxRequests',
        type: 'number',
        required: false,
        defaultValue: 0,
        tips: 'windowMaxRequestsTips',
        placeholder: 'phWindowMaxRequests',
      },
      ...apiBatchFields(10, 'batchSizeAutoFreeTips', {
        ...FIELD_REQUEST_INTERVAL,
        defaultValue: 0.3,
      }),
    ],
  },
  {
    id: 'bingFree',
    name: 'bingFree',
    isBuiltin: true,
    isAi: false,
    group: 'free',
    icon: '🅱️',
    iconImg: '/images/providers/bing-color.svg',
    fields: [
      {
        key: 'windowMaxRequests',
        label: 'windowMaxRequests',
        type: 'number',
        required: false,
        defaultValue: 0,
        tips: 'windowMaxRequestsTips',
        placeholder: 'phWindowMaxRequests',
      },
      ...apiBatchFields(10, 'batchSizeBingFreeTips', {
        ...FIELD_REQUEST_INTERVAL,
        defaultValue: 0.2,
      }),
    ],
  },
  {
    id: 'googleFree',
    name: 'googleFree',
    isBuiltin: true,
    isAi: false,
    group: 'free',
    icon: '🔎',
    iconImg: '/images/providers/googletranslate.svg',
    fields: [
      {
        key: 'windowMaxRequests',
        label: 'windowMaxRequests',
        type: 'number',
        required: false,
        defaultValue: 0,
        tips: 'windowMaxRequestsTips',
        placeholder: 'phWindowMaxRequests',
      },
      ...apiBatchFields(5, 'batchSizeGoogleFreeTips', {
        ...FIELD_REQUEST_INTERVAL,
        defaultValue: 0.5,
      }),
    ],
  },
  {
    id: 'google',
    name: 'Google Translate',
    isBuiltin: true,
    isAi: false,
    group: 'free',
    icon: '🇬',
    iconImg: '/images/providers/googletranslate.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'googleApiKeyTips',
        placeholder: 'phGoogleApiKey',
      },
      ...apiBatchFields(50, 'batchSizeGoogleTips'),
    ],
  },
  {
    id: 'aliyun',
    name: 'aliyun',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '☁️',
    iconImg: '/images/providers/alibabacloud.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'AccessKey ID',
        type: 'password',
        required: true,
        tips: 'aliyunApiKeyTips',
        placeholder: 'phAliyunAccessKeyId',
      },
      {
        key: 'apiSecret',
        label: 'AccessKey Secret',
        type: 'password',
        required: true,
        placeholder: 'phAliyunAccessKeySecret',
      },
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'text',
        required: false,
        defaultValue: 'mt.aliyuncs.com',
        tips: 'endpointAliyunTips',
        placeholder: 'phAliyunEndpoint',
      },
      ...apiBatchFields(15, 'batchSizeAliyunTips'),
    ],
  },
  {
    id: 'volc',
    name: 'volc',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🌋',
    iconImg: '/images/providers/volcengine-color.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'Access Key ID',
        type: 'password',
        required: true,
        tips: 'volcApiKeyTips',
        placeholder: 'phVolcAccessKeyId',
      },
      {
        key: 'apiSecret',
        label: 'Secret Access Key',
        type: 'password',
        required: true,
        placeholder: 'phVolcSecretAccessKey',
      },
      ...apiBatchFields(15, 'batchSizeVolcTips'),
    ],
  },
  {
    id: 'doubao',
    name: '豆包翻译',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🫛',
    iconImg: '/images/providers/doubao-color.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'doubaoApiKeyTips',
        placeholder: 'phDoubaoApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'text',
        required: false,
        defaultValue: 'doubao-seed-translation-250915',
        tips: 'doubaoModelNameTips',
        placeholder: 'doubao-seed-translation-250915',
      },
      ...apiBatchFields(1, 'batchSizeDoubaoTips'),
    ],
  },
  {
    id: 'niutrans',
    name: 'niutrans',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🐮',
    iconImg: '/images/providers/niutrans.png',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'niutransApiKeyTips',
        placeholder: 'phNiutransApiKey',
      },
      ...apiBatchFields(1, 'batchSizeNiutransTips'),
    ],
  },
  {
    id: 'tencent',
    name: 'tencent',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🐧',
    iconImg: '/images/providers/tencentcloud-color.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'SecretId',
        type: 'password',
        required: true,
        tips: 'tencentApiKeyTips',
        placeholder: 'phTencentSecretId',
      },
      {
        key: 'apiSecret',
        label: 'SecretKey',
        type: 'password',
        required: true,
        placeholder: 'phTencentSecretKey',
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: false,
        defaultValue: 'ap-guangzhou',
        tips: 'regionTencentTips',
        placeholder: 'phTencentRegion',
      },
      ...apiBatchFields(1, 'batchSizeTencentTips', tencentRequestIntervalField),
    ],
  },
  {
    id: 'xunfei',
    name: 'xunfei',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '🗣️',
    iconImg: '/images/providers/spark-color.svg',
    fields: [
      {
        key: 'appId',
        label: 'APPID',
        type: 'password',
        required: true,
        tips: 'xunfeiApiKeyTips',
        placeholder: 'phXunfeiAppId',
      },
      {
        key: 'apiKey',
        label: 'APIKey',
        type: 'password',
        required: true,
        placeholder: 'phXunfeiApiKey',
      },
      {
        key: 'apiSecret',
        label: 'APISecret',
        type: 'password',
        required: true,
        placeholder: 'phXunfeiApiSecret',
      },
      ...apiBatchFields(1, 'batchSizeXunfeiTips'),
    ],
  },
  {
    id: 'deeplx',
    name: 'DeepLX',
    isBuiltin: true,
    isAi: false,
    group: 'free',
    icon: '🌐',
    iconImg: '/images/providers/deepl-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        defaultValue: 'http://localhost:1188/translate',
        tips: 'deeplxApiUrlTips',
        placeholder: 'phDeeplxApiUrl',
      },
    ],
  },
  {
    id: 'azure',
    name: 'azure',
    isBuiltin: true,
    isAi: false,
    group: 'mt',
    icon: '☁️',
    iconImg: '/images/providers/azure-color.svg',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'azureApiKeyTips',
        placeholder: 'phAzureApiKey',
      },
      {
        key: 'apiSecret',
        label: 'Region',
        type: 'password',
        required: true,
        placeholder: 'phAzureRegion',
      },
      ...apiBatchFields(20, 'batchSizeAzureTips'),
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    isBuiltin: true,
    isAi: true,
    group: 'free',
    icon: '🤖',
    iconImg: '/images/providers/ollama.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        tips: 'ollamaApiUrlTips',
        placeholder: 'phOllamaApiUrl',
        defaultValue: 'http://localhost:11434/api/chat',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: 'selectModel',
        options: [],
      },
      // ollama ≥0.5 支持 schema 约束解码，是本地小模型条数对齐的最大收益点；
      // 旧版本由运行时回退链自动降级（openspec: ai-translation-alignment）
      ...aiCommonFields({ batchSize: 10, structuredOutput: 'json_schema' }),
    ],
  },
  {
    id: 'deepseek',
    name: 'Deepseek',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '🧠',
    iconImg: '/images/providers/deepseek-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        placeholder: 'https://api.deepseek.com/v1',
        defaultValue: 'https://api.deepseek.com/v1',
        tips: 'deepseekApiUrlTips',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'deepseekApiKeyTips',
        placeholder: 'phDeepseekApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: 'selectModel',
        options: [],
      },
      ...aiCommonFields(),
    ],
  },
  {
    id: 'azureopenai',
    name: 'Azure OpenAI',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '☁️',
    iconImg: '/images/providers/azureai-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        placeholder:
          'https://{your-resource-name}.openai.azure.com/openai/deployments/{deployment-id}',
        tips: 'azureOpenAiApiUrlTips',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'azureOpenAiApiKeyTips',
        placeholder: 'phAzureOpenAiApiKey',
      },
      ...aiCommonFields({ structuredOutput: 'json_schema' }),
    ],
  },
  {
    id: 'DeerAPI',
    name: 'DeerAPI',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '🐺',
    iconImg: '/images/deerapi.png',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        tips: 'DeerApiUrlTips',
        placeholder: 'https://api.deerapi.com/v1',
        defaultValue: 'https://api.deerapi.com/v1',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'deerApiKeyTips',
        placeholder: 'phDeerApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: 'selectModel',
        options: [],
      },
      ...aiCommonFields({ batchSize: 10 }),
    ],
  },
  {
    id: 'Gemini',
    name: 'Gemini',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '🌀',
    iconImg: '/images/providers/gemini-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        placeholder: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultValue:
          'https://generativelanguage.googleapis.com/v1beta/openai/',
        tips: 'geminiApiUrlTips',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'geminiApiKeyTips',
        placeholder: 'phGeminiApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'text',
        required: true,
        placeholder: 'gemini-2.0-flash',
        defaultValue: 'gemini-2.0-flash',
      },
      ...aiCommonFields({ structuredOutput: 'json_schema' }),
    ],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '🔮',
    iconImg: '/images/providers/siliconcloud-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        placeholder: 'https://api.siliconflow.cn/v1',
        defaultValue: 'https://api.siliconflow.cn/v1',
        tips: 'siliconflowApiUrlTips',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'siliconflowApiKeyTips',
        placeholder: 'phSiliconflowApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: 'selectModel',
        options: [],
      },
      ...aiCommonFields(),
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    isBuiltin: true,
    isAi: true,
    group: 'ai',
    icon: '🐋',
    iconImg: '/images/providers/qwen-color.svg',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultValue: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        tips: 'qwenApiUrlTips',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'qwenApiKeyTips',
        placeholder: 'phQwenApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: 'selectModel',
        options: [],
      },
      ...aiCommonFields(),
    ],
  },
];

export const CONFIG_TEMPLATES: Record<string, ProviderType> = {
  openai: {
    id: 'openai_template',
    name: 'OpenAI API',
    isAi: true,
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        tips: 'openaiApiUrlTips',
        placeholder: 'phOpenaiApiUrl',
        defaultValue: 'https://api.openai.com/v1',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'openaiApiKeyTips',
        placeholder: 'phOpenaiApiKey',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'text',
        required: true,
        placeholder: 'hunyuan-3.0-preview',
        tips: 'openaiModelNameTips',
      },
      ...aiCommonFields({ structuredOutput: 'json_object' }),
    ],
  },
};
