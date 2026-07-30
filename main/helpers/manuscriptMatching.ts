import fs from 'fs';
import path from 'path';

export const MANUSCRIPT_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;
export const MANUSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

export type ManuscriptFileErrorCode =
  | 'unsupported'
  | 'notFound'
  | 'notFile'
  | 'tooLarge'
  | 'empty'
  | 'invalidEncoding'
  | 'unreadable';

export class ManuscriptFileError extends Error {
  constructor(
    public readonly code: ManuscriptFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManuscriptFileError';
  }
}

export interface ManuscriptConfig {
  path: string;
  name: string;
}

export interface LoadedManuscript extends ManuscriptConfig {
  text: string;
  size: number;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
  characterCount: number;
}

/** Renderer 所需的最小 IPC 返回值；刻意不包含文稿正文。 */
export interface ManuscriptSelectionPayload extends ManuscriptConfig {
  size: number;
  encoding: LoadedManuscript['encoding'];
  characterCount: number;
}

export interface ManuscriptMatchCue {
  text: string;
  [key: string]: unknown;
}

export interface ManuscriptCueMatch {
  cueStart: number;
  cueCount: number;
  manuscriptUnitStart: number;
  manuscriptUnitCount: number;
  confidence: number;
  originalTexts: string[];
  replacementTexts: string[];
}

export interface ManuscriptMatchResult<T extends ManuscriptMatchCue> {
  cues: T[];
  totalCues: number;
  replacedCues: number;
  matchedGroups: number;
  averageConfidence: number;
  manuscriptUnits: number;
  matches: ManuscriptCueMatch[];
}

interface ComparableChar {
  value: string;
  start: number;
  end: number;
}

interface ComparableSequence {
  value: string;
  length: number;
  bigrams: Map<string, number>;
}

interface ManuscriptUnit {
  text: string;
  comparable: ComparableSequence;
}

interface MatchCandidate {
  cueCount: number;
  manuscriptStart: number;
  manuscriptCount: number;
  similarity: number;
  rank: number;
}

const MAX_GROUP_SIZE = 3;
const LOCAL_LOOKAHEAD = 24;
const MAX_INDEXED_POSITIONS = 120;
const MAX_FAR_CANDIDATES = 60;

export function getManuscriptConfig(
  formData?: Record<string, unknown>,
): ManuscriptConfig | null {
  const manuscriptPath =
    typeof formData?.manuscriptPath === 'string'
      ? formData.manuscriptPath.trim()
      : '';
  if (!manuscriptPath) return null;
  const configuredName =
    typeof formData?.manuscriptName === 'string'
      ? formData.manuscriptName.trim()
      : '';
  return {
    path: manuscriptPath,
    name: configuredName || path.basename(manuscriptPath),
  };
}

export function isSupportedManuscriptPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return MANUSCRIPT_EXTENSIONS.includes(
    extension as (typeof MANUSCRIPT_EXTENSIONS)[number],
  );
}

function decodeUtf16Be(buffer: Buffer): string {
  const body = Buffer.from(buffer.subarray(2));
  for (let index = 0; index + 1 < body.length; index += 2) {
    const first = body[index];
    body[index] = body[index + 1];
    body[index + 1] = first;
  }
  return body.toString('utf16le');
}

function decodeManuscriptBuffer(buffer: Buffer): {
  text: string;
  encoding: LoadedManuscript['encoding'];
} {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      text: buffer.subarray(2).toString('utf16le'),
      encoding: 'utf-16le',
    };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeUtf16Be(buffer), encoding: 'utf-16be' };
  }

  const body =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(body),
      encoding: 'utf-8',
    };
  } catch {
    // Windows 上的中文纯文本文稿仍常见 GBK/GB18030。WHATWG 的 gb18030
    // 解码器覆盖 GBK，作为 UTF-8 严格解码失败后的单一、确定性回退。
    try {
      return {
        text: new TextDecoder('gb18030', { fatal: true }).decode(body),
        encoding: 'gb18030',
      };
    } catch {
      throw new ManuscriptFileError(
        'invalidEncoding',
        'Manuscript must be UTF-8, UTF-16, GBK, or GB18030 text',
      );
    }
  }
}

/**
 * 将 Markdown 转为适合字幕匹配的可见文本。这里刻意只剥离语法标记，保留标题、
 * 列表和代码块里的文字；未在音频里念出的结构文字会由单调对齐的 skip 路径跳过。
 */
export function normalizeManuscriptText(
  input: string,
  markdown = false,
): string {
  let text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  if (markdown) {
    text = text
      .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*```[^\n]*$/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
      .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1');
  }
  return text
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readManuscriptFile(
  filePath: string,
): Promise<LoadedManuscript> {
  if (!isSupportedManuscriptPath(filePath)) {
    throw new ManuscriptFileError(
      'unsupported',
      `Unsupported manuscript extension: ${path.extname(filePath)}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? 'notFound'
        : 'unreadable';
    throw new ManuscriptFileError(code, `Cannot access manuscript: ${error}`);
  }
  if (!stat.isFile()) {
    throw new ManuscriptFileError(
      'notFile',
      'The selected manuscript is not a file',
    );
  }
  if (stat.size > MANUSCRIPT_MAX_BYTES) {
    throw new ManuscriptFileError(
      'tooLarge',
      `Manuscript exceeds ${MANUSCRIPT_MAX_BYTES} bytes`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(filePath);
  } catch (error) {
    throw new ManuscriptFileError(
      'unreadable',
      `Cannot read manuscript: ${error}`,
    );
  }
  const decoded = decodeManuscriptBuffer(buffer);
  const extension = path.extname(filePath).toLowerCase();
  const text = normalizeManuscriptText(
    decoded.text,
    extension === '.md' || extension === '.markdown',
  );
  if (!text || toComparableChars(text).length === 0) {
    throw new ManuscriptFileError(
      'empty',
      'The manuscript contains no matchable text',
    );
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    text,
    size: stat.size,
    encoding: decoded.encoding,
    characterCount: Array.from(text).length,
  };
}

export function toManuscriptSelectionPayload(
  manuscript: LoadedManuscript,
): ManuscriptSelectionPayload {
  return {
    path: manuscript.path,
    name: manuscript.name,
    size: manuscript.size,
    encoding: manuscript.encoding,
    characterCount: manuscript.characterCount,
  };
}

function toComparableChars(text: string): ComparableChar[] {
  const chars: ComparableChar[] = [];
  const matcher = /./gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    // 不使用 toLocaleLowerCase：土耳其语等系统区域会让相同文件产生不同匹配结果。
    const normalized = match[0].normalize('NFKC').toLowerCase();
    for (const normalizedChar of normalized) {
      if (!/[\p{L}\p{N}]/u.test(normalizedChar)) continue;
      chars.push({
        value: normalizedChar,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return chars;
}

function makeComparable(text: string): ComparableSequence {
  const symbols = toComparableChars(text).map((item) => item.value);
  const value = symbols.join('');
  const bigrams = new Map<string, number>();
  if (symbols.length === 1) {
    bigrams.set(symbols[0], 1);
  } else {
    for (let index = 0; index + 1 < symbols.length; index += 1) {
      const gram = symbols[index] + symbols[index + 1];
      bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
    }
  }
  return { value, length: symbols.length, bigrams };
}

function joinVisibleText(parts: string[]): string {
  let output = '';
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (!output) {
      output = part;
      continue;
    }
    const last = output.at(-1) ?? '';
    const first = part.at(0) ?? '';
    const firstIsCjk =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        first,
      );
    const visibleLatinBoundary =
      !firstIsCjk && /[\p{L}\p{N}]/u.test(first) && !/\s/u.test(last);
    output += `${visibleLatinBoundary ? ' ' : ''}${part}`;
  }
  return output;
}

function splitLongUnit(text: string, targetLength = 56): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (toComparableChars(rest).length > targetLength * 1.5) {
    const chars = toComparableChars(rest);
    const targetIndex = Math.min(targetLength, chars.length - 1);
    const minRaw = chars[Math.max(1, Math.floor(targetLength * 0.55))]?.start;
    const maxRaw =
      chars[Math.min(chars.length - 1, Math.ceil(targetLength * 1.35))]?.end ??
      rest.length;
    const targetRaw = chars[targetIndex]?.end ?? rest.length;
    const candidates: number[] = [];
    for (let index = minRaw ?? 1; index <= maxRaw; index += 1) {
      if (/[\s，,、：:]/u.test(rest[index] ?? '')) {
        candidates.push(index + 1);
      }
    }
    const cut =
      candidates.sort(
        (left, right) =>
          Math.abs(left - targetRaw) - Math.abs(right - targetRaw),
      )[0] ?? targetRaw;
    const head = rest.slice(0, cut).trim();
    if (!head || cut <= 0) break;
    parts.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function segmentManuscript(text: string): string[] {
  const normalized = normalizeManuscriptText(text);
  const initial: string[] = [];
  for (const paragraph of normalized.split(/\n+/)) {
    let start = 0;
    for (let index = 0; index < paragraph.length; index += 1) {
      const current = paragraph[index];
      const next = paragraph[index + 1] ?? '';
      const hardBoundary = /[。！？!?；;]/u.test(current);
      const englishPeriodBoundary =
        current === '.' && (!next || /\s/u.test(next));
      if (!hardBoundary && !englishPeriodBoundary) continue;
      const piece = paragraph.slice(start, index + 1).trim();
      if (piece) initial.push(piece);
      start = index + 1;
      while (start < paragraph.length && /\s/u.test(paragraph[start])) {
        start += 1;
      }
      index = start - 1;
    }
    const tail = paragraph.slice(start).trim();
    if (tail) initial.push(tail);
  }
  return initial
    .flatMap((piece) => splitLongUnit(piece))
    .filter((piece) => toComparableChars(piece).length > 0);
}

function diceSimilarity(
  left: ComparableSequence,
  right: ComparableSequence,
): number {
  if (!left.length || !right.length) return 0;
  if (left.value === right.value) return 1;
  if (left.length === 1 || right.length === 1) {
    return left.value === right.value ? 1 : 0;
  }
  const smaller =
    left.bigrams.size <= right.bigrams.size ? left.bigrams : right.bigrams;
  const larger = smaller === left.bigrams ? right.bigrams : left.bigrams;
  let intersection = 0;
  smaller.forEach((count, gram) => {
    intersection += Math.min(count, larger.get(gram) ?? 0);
  });
  const leftTotal = Math.max(1, left.length - 1);
  const rightTotal = Math.max(1, right.length - 1);
  const dice = (2 * intersection) / (leftTotal + rightTotal);
  const lengthRatio =
    Math.min(left.length, right.length) / Math.max(left.length, right.length);
  return dice * 0.88 + lengthRatio * 0.12;
}

/**
 * 置信阈值依据：
 * - 24+ 可比较字符有足够上下文，允许约 20% 的 ASR 字符/二元组误差（0.76）；
 * - 12–23 字符提高到 0.82；
 * - 更短片段容易和口头禅/标题误撞，分别要求 0.88 / 0.94。
 * 同时对 0.94 以下候选要求至少 0.025 的次优间隔，避免重复句误配。
 */
export function manuscriptConfidenceThreshold(evidenceLength: number): number {
  if (evidenceLength >= 24) return 0.76;
  if (evidenceLength >= 12) return 0.82;
  if (evidenceLength >= 6) return 0.88;
  return 0.94;
}

function makeGroupComparable(
  texts: string[],
  start: number,
  count: number,
  cache: Map<string, ComparableSequence>,
): ComparableSequence {
  const key = `${start}:${count}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const value = makeComparable(
    joinVisibleText(texts.slice(start, start + count)),
  );
  cache.set(key, value);
  return value;
}

function uniqueTrigrams(value: string): string[] {
  const grams = new Set<string>();
  const symbols = Array.from(value);
  if (symbols.length < 3) return [];
  for (let index = 0; index + 2 < symbols.length; index += 1) {
    grams.add(symbols[index] + symbols[index + 1] + symbols[index + 2]);
  }
  return Array.from(grams);
}

function buildTrigramIndex(units: ManuscriptUnit[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  units.forEach((unit, unitIndex) => {
    for (const gram of uniqueTrigrams(unit.comparable.value)) {
      const positions = index.get(gram) ?? [];
      if (positions.length < MAX_INDEXED_POSITIONS) positions.push(unitIndex);
      index.set(gram, positions);
    }
  });
  return index;
}

function candidateStarts(
  cueComparable: ComparableSequence,
  cursor: number,
  unitCount: number,
  trigramIndex: Map<string, number[]>,
): number[] {
  const starts = new Set<number>();
  for (
    let index = cursor;
    index < Math.min(unitCount, cursor + LOCAL_LOOKAHEAD);
    index += 1
  ) {
    starts.add(index);
  }

  const votes = new Map<number, number>();
  const rareGrams = uniqueTrigrams(cueComparable.value)
    .map((gram) => ({ gram, positions: trigramIndex.get(gram) ?? [] }))
    .filter((item) => item.positions.length > 0)
    .sort((left, right) => left.positions.length - right.positions.length)
    .slice(0, 10);
  for (const { positions } of rareGrams) {
    for (const position of positions) {
      for (let offset = 0; offset < MAX_GROUP_SIZE; offset += 1) {
        const start = position - offset;
        if (start >= cursor && start < unitCount) {
          votes.set(start, (votes.get(start) ?? 0) + 1);
        }
      }
    }
  }
  Array.from(votes.entries())
    .sort(
      ([leftPos, leftVotes], [rightPos, rightVotes]) =>
        rightVotes - leftVotes || leftPos - rightPos,
    )
    .slice(0, MAX_FAR_CANDIDATES)
    .forEach(([position]) => starts.add(position));
  return Array.from(starts).sort((left, right) => left - right);
}

function splitTextByWeights(text: string, weights: number[]): string[] | null {
  if (weights.length === 1) return [text.trim()];
  const chars = toComparableChars(text);
  if (chars.length < weights.length) return null;
  const safeWeights = weights.map((weight) => Math.max(1, weight));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const boundaries = [0];
  let cumulative = 0;
  for (let index = 0; index + 1 < safeWeights.length; index += 1) {
    cumulative += safeWeights[index];
    const desired = Math.round((cumulative / totalWeight) * chars.length);
    const minimum = boundaries[index] + 1;
    const maximum = chars.length - (safeWeights.length - index - 1);
    boundaries.push(Math.max(minimum, Math.min(maximum, desired)));
  }
  boundaries.push(chars.length);

  const result: string[] = [];
  for (let index = 0; index < weights.length; index += 1) {
    const fromChar = boundaries[index];
    const toChar = boundaries[index + 1];
    const rawStart = fromChar === 0 ? 0 : chars[fromChar].start;
    const rawEnd = toChar >= chars.length ? text.length : chars[toChar].start;
    const piece = text.slice(rawStart, rawEnd).trim();
    if (!piece) return null;
    result.push(piece);
  }
  return result;
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 按字幕与文稿顺序做单调匹配。算法只会向前移动文稿游标；每一步可合并最多三条
 * cue / 三个文稿单元，覆盖常见的分句粒度差异。局部窗口之外通过稀有三元组索引恢复
 * 锚点，因此文稿中的标题、舞台说明或 ASR 漏段不会让后续整体漂移。
 *
 * 只有超过长度分级阈值且不存在近似等价次优位置的组才替换。未命中的 cue 原样复制，
 * 返回对象也只修改 text 字段，调用方可据此保证时间轴不变。
 */
export function matchManuscriptToCues<T extends ManuscriptMatchCue>(
  inputCues: T[],
  manuscriptText: string,
): ManuscriptMatchResult<T> {
  const cues = inputCues.map((cue) => ({ ...cue }));
  const manuscriptUnits: ManuscriptUnit[] = segmentManuscript(
    manuscriptText,
  ).map((text) => ({ text, comparable: makeComparable(text) }));
  const result: ManuscriptMatchResult<T> = {
    cues,
    totalCues: cues.length,
    replacedCues: 0,
    matchedGroups: 0,
    averageConfidence: 0,
    manuscriptUnits: manuscriptUnits.length,
    matches: [],
  };
  if (cues.length === 0 || manuscriptUnits.length === 0) return result;

  const cueTexts = cues.map((cue) => String(cue.text ?? ''));
  const manuscriptTexts = manuscriptUnits.map((unit) => unit.text);
  const cueCache = new Map<string, ComparableSequence>();
  const manuscriptCache = new Map<string, ComparableSequence>();
  manuscriptUnits.forEach((unit, index) => {
    manuscriptCache.set(`${index}:1`, unit.comparable);
  });
  const trigramIndex = buildTrigramIndex(manuscriptUnits);

  let cueIndex = 0;
  let manuscriptCursor = 0;
  let confidenceTotal = 0;
  while (cueIndex < cues.length && manuscriptCursor < manuscriptUnits.length) {
    // 同一文稿起点可能因 1↔多分组产生多个候选。先按起点去重，最终再从
    // “不同起点”里取次优，避免把同一位置的另一分组误当成歧义候选。
    const bestByManuscriptStart = new Map<number, MatchCandidate>();

    for (
      let cueCount = 1;
      cueCount <= MAX_GROUP_SIZE && cueIndex + cueCount <= cues.length;
      cueCount += 1
    ) {
      const cueComparable = makeGroupComparable(
        cueTexts,
        cueIndex,
        cueCount,
        cueCache,
      );
      if (!cueComparable.length) continue;
      const starts = candidateStarts(
        cueComparable,
        manuscriptCursor,
        manuscriptUnits.length,
        trigramIndex,
      );
      for (const manuscriptStart of starts) {
        for (
          let manuscriptCount = 1;
          manuscriptCount <= MAX_GROUP_SIZE &&
          manuscriptStart + manuscriptCount <= manuscriptUnits.length;
          manuscriptCount += 1
        ) {
          const referenceComparable = makeGroupComparable(
            manuscriptTexts,
            manuscriptStart,
            manuscriptCount,
            manuscriptCache,
          );
          const lengthRatio =
            Math.min(cueComparable.length, referenceComparable.length) /
            Math.max(cueComparable.length, referenceComparable.length);
          if (lengthRatio < 0.45) continue;
          const similarity = diceSimilarity(cueComparable, referenceComparable);
          // 远距离锚点轻微降权，只负责打破相似候选平局；高置信远端仍可恢复。
          const skippedUnits = manuscriptStart - manuscriptCursor;
          const rank =
            similarity -
            Math.min(skippedUnits, 400) * 0.00008 -
            (cueCount + manuscriptCount - 2) * 0.002;
          const candidate: MatchCandidate = {
            cueCount,
            manuscriptStart,
            manuscriptCount,
            similarity,
            rank,
          };
          const existingAtStart = bestByManuscriptStart.get(manuscriptStart);
          if (!existingAtStart || candidate.rank > existingAtStart.rank) {
            bestByManuscriptStart.set(manuscriptStart, candidate);
          }
        }
      }
    }

    const candidates = Array.from(bestByManuscriptStart.values());
    const best =
      candidates.sort((left, right) => right.rank - left.rank)[0] ?? null;
    if (!best) {
      cueIndex += 1;
      continue;
    }
    const secondAtDifferentPosition =
      candidates
        .filter(
          (candidate) => candidate.manuscriptStart !== best.manuscriptStart,
        )
        .sort((left, right) => right.similarity - left.similarity)[0] ?? null;
    const bestCueComparable = makeGroupComparable(
      cueTexts,
      cueIndex,
      best.cueCount,
      cueCache,
    );
    const threshold = manuscriptConfidenceThreshold(bestCueComparable.length);
    const margin =
      best.similarity - (secondAtDifferentPosition?.similarity ?? 0);
    const unambiguous = best.similarity >= 0.94 || margin >= 0.025;
    if (best.similarity < threshold || !unambiguous) {
      cueIndex += 1;
      continue;
    }

    const referenceText = joinVisibleText(
      manuscriptTexts.slice(
        best.manuscriptStart,
        best.manuscriptStart + best.manuscriptCount,
      ),
    );
    const cueWeights = cueTexts
      .slice(cueIndex, cueIndex + best.cueCount)
      .map((text) => Math.max(1, makeComparable(text).length));
    const replacements = splitTextByWeights(referenceText, cueWeights);
    if (!replacements || replacements.length !== best.cueCount) {
      cueIndex += 1;
      continue;
    }

    const originalTexts: string[] = [];
    replacements.forEach((replacement, offset) => {
      originalTexts.push(String(cues[cueIndex + offset].text ?? ''));
      cues[cueIndex + offset].text = replacement;
    });
    const match: ManuscriptCueMatch = {
      cueStart: cueIndex,
      cueCount: best.cueCount,
      manuscriptUnitStart: best.manuscriptStart,
      manuscriptUnitCount: best.manuscriptCount,
      confidence: roundConfidence(best.similarity),
      originalTexts,
      replacementTexts: replacements,
    };
    result.matches.push(match);
    result.replacedCues += best.cueCount;
    result.matchedGroups += 1;
    confidenceTotal += best.similarity * best.cueCount;
    cueIndex += best.cueCount;
    manuscriptCursor = best.manuscriptStart + best.manuscriptCount;
  }

  result.averageConfidence =
    result.replacedCues > 0
      ? roundConfidence(confidenceTotal / result.replacedCues)
      : 0;
  return result;
}
