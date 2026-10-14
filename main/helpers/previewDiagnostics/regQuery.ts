/**
 * `reg query` 输出的解析（纯函数，不依赖 electron，便于直接测试）。
 */

export interface RegValue {
  type: string;
  data: string;
}

export interface RegKeyDump {
  key: string;
  values: Record<string, RegValue>;
}

/**
 * 解析 `reg query` 的输出：键名一行，其后是缩进的「名称  类型  数据」。
 * 名称里可能有空格，所以按「两个以上空格」切，而不是单个空格。
 */
export function parseRegQuery(text: string): RegKeyDump[] {
  const dumps: RegKeyDump[] = [];
  let current: RegKeyDump | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      current = { key: raw.trim(), values: {} };
      dumps.push(current);
      continue;
    }
    if (!current) continue;
    const match = raw.trim().match(/^(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/);
    if (match) {
      current.values[match[1]] = {
        type: match[2],
        data: (match[3] ?? '').trim(),
      };
    }
  }
  return dumps;
}
