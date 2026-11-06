// Canonical names from QwenLM/Qwen3-ASR's inference/utils.py SUPPORTED_LANGUAGES.
// None denotes unknown language / empty audio; it does not invalidate a body.
const QWEN_LANGUAGES = [
  'Chinese',
  'English',
  'Cantonese',
  'Arabic',
  'German',
  'French',
  'Spanish',
  'Portuguese',
  'Indonesian',
  'Italian',
  'Korean',
  'Russian',
  'Thai',
  'Vietnamese',
  'Japanese',
  'Turkish',
  'Hindi',
  'Malay',
  'Dutch',
  'Swedish',
  'Danish',
  'Finnish',
  'Polish',
  'Czech',
  'Filipino',
  'Persian',
  'Greek',
  'Romanian',
  'Hungarian',
  'Macedonian',
  'None',
];

const LANGUAGE_HEADER = String.raw`(?:language(?:\s*[:：]\s*|\s+)(?:${QWEN_LANGUAGES.join('|')})|语言\s*[:：]?\s*(?:中文|英文|粤语))`;
const ASR_OPENING_TAG = String.raw`<\s*asr_text\s*>`;
const ASR_TAG = String.raw`<\s*\/?\s*asr_text\s*>`;
const LEADING_SCAFFOLD = new RegExp(
  String.raw`^(?:(\*{1,2})(?!\*)\s*)?(?:${LANGUAGE_HEADER}\s*)?${ASR_OPENING_TAG}`,
  'i',
);
const ORPHAN_LANGUAGE_HEADER = new RegExp(
  String.raw`^${LANGUAGE_HEADER}\s*[.。:：]?$`,
  'i',
);
const HEADER_WRAPPERS = [
  ['**', '**'],
  ['*', '*'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
];

function trimEdges(text: string): string {
  return text.replace(/^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/g, '');
}

function isOrphanLanguageHeader(text: string): boolean {
  if (ORPHAN_LANGUAGE_HEADER.test(text)) return true;
  return HEADER_WRAPPERS.some(
    ([open, close]) =>
      text.startsWith(open) &&
      text.endsWith(close) &&
      ORPHAN_LANGUAGE_HEADER.test(
        trimEdges(text.slice(open.length, -close.length)),
      ),
  );
}

/**
 * Parse leaked Qwen protocol text once, before subtitle splitting (#451/#490).
 * Exact standalone language headers are treated as metadata, even though speech
 * could contain the same phrase. Never apply that heuristic to an extracted body
 * or infer hallucinations from the language/length of ordinary words.
 */
export function sanitizeQwenAsrText(text: string | null | undefined): string {
  if (!text) return '';
  let cleaned = trimEdges(text);
  if (isOrphanLanguageHeader(cleaned)) return '';

  // Consume consecutive leading headers, not everything before the last tag.
  // A closing tag terminates speech; it cannot turn that speech into a header.
  let prefix: RegExpExecArray | null;
  while ((prefix = LEADING_SCAFFOLD.exec(cleaned))) {
    cleaned = trimEdges(cleaned.slice(prefix[0].length));
    const wrapper = prefix[1];
    // Only remove a matching closing decoration from a recognized scaffold.
    if (
      wrapper &&
      cleaned.endsWith(wrapper) &&
      cleaned.charAt(cleaned.length - wrapper.length - 1) !== '*'
    ) {
      cleaned = trimEdges(cleaned.slice(0, -wrapper.length));
    }
  }

  // Preserve all intervening speech and whitespace, including after None.
  return trimEdges(cleaned.replace(new RegExp(ASR_TAG, 'gi'), ''));
}
