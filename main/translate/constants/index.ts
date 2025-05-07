export const CONTENT_TEMPLATES = {
  onlyTranslate: '${targetContent}\n\n',
  sourceAndTranslate: '${sourceContent}\n${targetContent}\n\n',
  translateAndSource: '${targetContent}\n${sourceContent}\n\n',
} as const;

export const DEFAULT_BATCH_SIZE = {
  AI: 10,
  API: 1,
} as const;

export const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>\n/g;
export const RESULT_TAG_REGEX = /<result[^>]*>([\s\S]*?)<\/result>/;

// 获取 ```json\n{content}\n``` 中的 content
export const JSON_CONTENT_REGEX = /```json\n([\s\S]*?)\n```/;
