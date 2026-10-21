const KEY = 'smartsub:recentFonts';
const LIMIT = 8;

export function readRecentFonts(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Newest first, without duplicates; storage failures never block font choice. */
export function rememberRecentFont(name: string) {
  try {
    const next = [name, ...readRecentFonts().filter((item) => item !== name)];
    window.localStorage.setItem(KEY, JSON.stringify(next.slice(0, LIMIT)));
  } catch {
    /* Recent fonts are a convenience only. */
  }
}
