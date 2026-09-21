/** Transform top-level override tags without rewriting nested transforms or comments. */
export function mapAssOverrideTags(
  block: string,
  transform: (tag: string) => string,
): string {
  let result = '';
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= block.length; index++) {
    const character = block[index];
    if (index === block.length || (character === '\\' && depth === 0)) {
      const part = block.slice(start, index);
      result += part.startsWith('\\') ? transform(part) : part;
      start = index;
    }
    if (character === '(') depth++;
    if (character === ')') depth = Math.max(0, depth - 1);
  }
  return result;
}

export function mapAssOverrideBlocks(
  text: string,
  transform: (tag: string) => string,
): string {
  return text.replace(/\{([^}]*)\}/g, (_block, body: string) => {
    const updated = mapAssOverrideTags(body, transform);
    return updated ? `{${updated}}` : '';
  });
}
