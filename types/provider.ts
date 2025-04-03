export type ProviderField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'url' | 'number' | 'switch' | 'select';
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
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
};

export type Provider = {
  id: string;
  name: string;
  type: string;
  isAi: boolean;
  [key: string]: any;
};

export const defaultUserPrompt  = '${content}';
export const defaultSystemPrompt = `# Role: 资深翻译专家
你是一位经验丰富的字幕翻译专家,精通\${targetLanguage}的翻译,擅长将视频字幕译成流畅易懂的\${targetLanguage}。

# Attention:
在整个翻译过程中，你需要注意以下几点：

1. 保持每条字幕的独立性和完整性，不合并或拆分。
2. 使用口语化的\${targetLanguage}，避免过于书面化的表达，以符合字幕的特点。
3. 适当使用标点符号，如逗号、句号，甚至省略号，来增强语气和节奏感。
4. 确保专业术语的准确性，并且在上下文中保持一致性。

最后，你需要检查整个翻译是否流畅，是否有语法错误，以及是否忠实于原文意思。特别是要注意译文与原文之间的差异，比如英语中常用被动语态，而中文则更多使用主动语态，所以在翻译时可能会做一些调整，以适应\${targetLanguage}的表达习惯。以及是终的翻译结果输出的 json 格式条数和原文是否完整保持一致。

# Examples

Input:
\`\`\`json
{\"0\": \"Welcome to China\", \"1\": \"China is a beautiful country\"}
\`\`\`

Output:
\`\`\`json
{\"0\": \"欢迎来到中国\", \"1\": \"中国是一个美丽的国家\"}
\`\`\`
`;



export const PROVIDER_TYPES: ProviderType[] = [
  {
    id: 'baidu',
    name: 'baidu',
    isBuiltin: true,
    isAi: false,
    icon: '🔤',
    fields: [
      { key: 'apiKey', label: 'APP ID', type: 'password', required: true },
      {
        key: 'apiSecret',
        label: 'Secret Key',
        type: 'password',
        required: true,
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        required: true,
        defaultValue: 18,
        tips: 'batchSizeBaiduTips',
      },
    ],
  },
  {
    id: 'volc',
    name: 'volc',
    isBuiltin: true,
    isAi: false,
    icon: '🌋',
    fields: [
      {
        key: 'apiKey',
        label: 'Access Key ID',
        type: 'password',
        required: true,
      },
      {
        key: 'apiSecret',
        label: 'Secret Access Key',
        type: 'password',
        required: true,
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        required: true,
        defaultValue: 15,
        tips: 'batchSizeVolcTips',
      },
    ],
  },
  {
    id: 'deeplx',
    name: 'DeepLX',
    isBuiltin: true,
    isAi: false,
    icon: '🌐',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        defaultValue: 'http://localhost:1188/translate',
      },
    ],
  },
  {
    id: 'azure',
    name: 'azure',
    isBuiltin: true,
    isAi: false,
    icon: '☁️',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'apiSecret', label: 'Region', type: 'password', required: true },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        required: true,
        defaultValue: 20,
        tips: 'batchSizeAzureTips',
      },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    isBuiltin: true,
    isAi: true,
    icon: '🤖',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        tips: 'ollamaApiUrlTips',
        placeholder: 'http://localhost:11434/api/chat',
        defaultValue: 'http://localhost:11434/api/chat',
      },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: '选择模型',
        options: [],
      },
      {
        key:'systemPrompt',
        label:'systemPrompt',
        type: 'textarea',
        tips:'systemPromptTips',
        defaultValue: defaultSystemPrompt,
      },
      {
        key: 'prompt',
        label: 'prompt',
        type: 'textarea',
        defaultValue: defaultUserPrompt,
        tips: 'userPromptTips',
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        defaultValue: 10,
        tips: 'batchSizeTip',
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'Deepseek',
    isBuiltin: true,
    isAi: true,
    icon: '🧠',
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        placeholder: 'https://api.deepseek.com/v1',
        defaultValue: 'https://api.deepseek.com/v1',
      },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'text',
        required: true,
        placeholder: 'deepseek-chat',
        defaultValue: 'deepseek-chat',
      },
      {
        key: 'systemPrompt',
        label: 'systemPrompt',
        type: 'textarea',
        tips: 'systemPromptTips',
        defaultValue: defaultSystemPrompt,
      },
      {
        key: 'prompt',
        label: 'prompt',
        type: 'textarea',
        defaultValue: defaultUserPrompt,
        tips: 'userPromptTips',
      },

      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        defaultValue: 1,
        tips: 'batchSizeTip',
      },
    ],
  },
  {
    id: 'azureopenai',
    name: 'Azure OpenAI',
    isBuiltin: true,
    isAi: true,
    icon: '☁️',
    fields: [
      {
        key: 'apiUrl',
        label: 'ApiUrl',
        type: 'url',
        required: true,
        placeholder:
          'https://{your-resource-name}.openai.azure.com/openai/deployments/{deployment-id}',
      },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      {
        key: 'systemPrompt',
        label: 'systemPrompt',
        type: 'textarea',
        tips: 'systemPromptTips',
        defaultValue: defaultSystemPrompt,
      },
      {
        key: 'prompt',
        label: 'prompt',
        type: 'textarea',
        defaultValue: defaultUserPrompt,
        tips: 'userPromptTips',
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        defaultValue: 1,
        tips: 'batchSizeTip',
      },
    ],
  },
  {
    id: 'DeerAPI',
    name: 'DeerAPI',
    isBuiltin: true,
    isAi: true,
    icon: '🐺',
    iconImg:'/images/deerapi.png',
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
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      {
        key: 'modelName',
        label: 'modelName',
        type: 'select',
        required: true,
        placeholder: '选择模型',
        options: [],
      },
      {
        key:'systemPrompt',
        label:'systemPrompt',
        type: 'textarea',
        tips:'systemPromptTips',
        defaultValue: defaultSystemPrompt,
      },
      {
        key: 'prompt',
        label: 'prompt',
        type: 'textarea',
        defaultValue: defaultUserPrompt,
        tips: 'userPromptTips',
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        defaultValue: 10,
        tips: 'batchSizeTip',
      },
    ],
  }, 
];

export const CONFIG_TEMPLATES: Record<string, ProviderType> = {
  openai: {
    id: 'openai_template',
    name: 'OpenAI API',
    isAi: true,
    fields: [
      { key: 'apiUrl', label: 'Base url', type: 'url', required: true },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'modelName', label: 'modelName', type: 'text', required: true },
      {
        key: 'systemPrompt',
        label: 'systemPrompt',
        type: 'textarea',
        tips:'systemPromptTips',
        defaultValue: defaultSystemPrompt,
      },
      {
        key: 'prompt',
        label: 'prompt',
        type: 'textarea',
        defaultValue: defaultUserPrompt,
        tips: 'userPromptTips',
      },
      {
        key: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        defaultValue: 1,
        tips: 'batchSizeTip',
      },
    ],
  },
};
