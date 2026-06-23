/**
 * 统一日期版本比较（addon 与（未来）py 共用）。
 * 把分隔符归一为点号后按字符串比较，适配 YYYY.MM.DD / YYYY-MM-DD。
 */
export function normalizeDateVersion(version: string): string {
  return version.replace(/-/g, '.');
}

/** a<b → -1；a>b → 1；相等 → 0 */
export function compareDateVersion(a: string, b: string): number {
  const na = normalizeDateVersion(a);
  const nb = normalizeDateVersion(b);
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}
