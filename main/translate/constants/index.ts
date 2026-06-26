export const CONTENT_TEMPLATES = {
  onlyTranslate: '${targetContent}\n\n',
  sourceAndTranslate: '${sourceContent}\n${targetContent}\n\n',
  translateAndSource: '${targetContent}\n${sourceContent}\n\n',
} as const;

export const DEFAULT_BATCH_SIZE = {
  AI: 10,
  API: 1,
} as const;

// 翻译请求超时时间（毫秒）。
// 防止单个请求无限挂起导致整个翻译流程卡死、进度永久停留（issue #269）。
export const TRANSLATION_REQUEST_TIMEOUT = 60_000;
// 本地大模型（Ollama）响应可能较慢，使用更宽松的超时时间。
export const OLLAMA_REQUEST_TIMEOUT = 300_000;

export const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>/gi;
export const RESULT_TAG_REGEX = /<result[^>]*>([\s\S]*?)<\/result>/i;

// 获取 ```json\n{content}\n``` 或 ```\n{content}\n``` 中的 content
export const JSON_CONTENT_REGEX = /```(?:json)?\s*([\s\S]*?)```/i;
