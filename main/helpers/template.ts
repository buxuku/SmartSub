export type TemplateData = Record<string, unknown>;

/**
 * 渲染 `${name}` 形式的简单模板变量。
 *
 * 使用回调替换，保证 `$&`、`$1` 等用户文本按字面量写入，而不是被
 * String.replace 当成替换模式。词库术语和字幕正文都可能合法包含这些字符。
 */
export function renderTemplate(template: string, data: TemplateData): string {
  return template.replace(/\$\{([^{}]+)\}/g, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return token;
    return data[key]?.toString() || '';
  });
}
