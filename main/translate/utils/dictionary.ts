export interface TranslationDictionaryEntry {
  source: string;
  target: string;
}

const SEPARATORS = ['=>', '->', '→', '\t', '='];

function splitDictionaryLine(line: string): TranslationDictionaryEntry | null {
  for (const separator of SEPARATORS) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;

    const source = line.slice(0, index).trim();
    const target = line.slice(index + separator.length).trim();
    if (!source || !target) return null;
    return { source, target };
  }

  return null;
}

function sortBySourceLength(
  entries: TranslationDictionaryEntry[],
): TranslationDictionaryEntry[] {
  return [...entries].sort((a, b) => b.source.length - a.source.length);
}

export function parseTranslationDictionary(
  dictionary?: string | TranslationDictionaryEntry[] | null,
): TranslationDictionaryEntry[] {
  if (!dictionary) return [];

  const parsed =
    typeof dictionary === 'string'
      ? dictionary
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
          .map(splitDictionaryLine)
          .filter((entry): entry is TranslationDictionaryEntry => !!entry)
      : dictionary
          .map((entry) => ({
            source: String(entry?.source || '').trim(),
            target: String(entry?.target || '').trim(),
          }))
          .filter((entry) => entry.source && entry.target);

  const bySource = new Map<string, TranslationDictionaryEntry>();
  parsed.forEach((entry) => {
    bySource.set(entry.source, entry);
  });

  return sortBySourceLength([...bySource.values()]);
}

export function formatTranslationDictionaryPrompt(
  entries?: TranslationDictionaryEntry[],
): string {
  const normalizedEntries = parseTranslationDictionary(entries);
  if (normalizedEntries.length === 0) return '';

  const lines = normalizedEntries
    .map((entry) => `- ${entry.source} => ${entry.target}`)
    .join('\n');

  return [
    '',
    '',
    'Terminology glossary:',
    lines,
    'When the source text contains a glossary source term, always use the corresponding target term in the translation.',
    'Keep the required JSON output shape exactly the same and do not add glossary notes or explanations.',
  ].join('\n');
}

export function applyTranslationDictionaryToText(
  text: string,
  entries?: TranslationDictionaryEntry[],
): string {
  if (!text || !entries?.length) return text;

  return sortBySourceLength(entries).reduce((output, entry) => {
    if (!entry.source || !entry.target || entry.source === entry.target) {
      return output;
    }
    return output.split(entry.source).join(entry.target);
  }, text);
}

export function applyTranslationDictionaryToResults<
  T extends { targetContent?: string },
>(results: T[], entries?: TranslationDictionaryEntry[]): T[] {
  if (!entries?.length) return results;

  return results.map((result) => {
    if (typeof result.targetContent !== 'string') return result;
    return {
      ...result,
      targetContent: applyTranslationDictionaryToText(
        result.targetContent,
        entries,
      ),
    };
  });
}
