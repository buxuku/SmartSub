import fs from 'fs';
import path from 'path';

export const MANUSCRIPT_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;
export const MANUSCRIPT_MAX_BYTES = 1024 * 1024;
export const MANUSCRIPT_MAX_COMPARABLE_CHARS = 500_000;
export const MANUSCRIPT_MAX_UNITS = 20_000;

export type ManuscriptFileErrorCode =
  | 'unsupported'
  | 'notFound'
  | 'notFile'
  | 'tooLarge'
  | 'tooComplex'
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
  /** Pre-segmented once during validated loading; never crosses the IPC boundary. */
  units: string[];
  size: number;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
  characterCount: number;
  comparableCharacterCount: number;
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

export interface ManuscriptMatchOptions {
  signal?: AbortSignal;
  /** Reuses units produced by readManuscriptFile to avoid parsing a large file twice. */
  manuscriptUnits?: string[];
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
const MAX_UNORDERED_ORDERED_GAP = 0.08;
const MIN_SINGLE_CHARACTER_EDIT_LENGTH = 10;
const REORDER_NGRAM_SIZES = [2, 3] as const;
const MIN_REORDER_ANCHOR_DISPLACEMENT = 4;
const YIELD_EVERY_OPERATIONS = 2048;

function manuscriptAbortError(): Error {
  const error = new Error('Manuscript matching cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw manuscriptAbortError();
}

async function cooperativeYield(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

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
  options: { signal?: AbortSignal } = {},
): Promise<LoadedManuscript> {
  throwIfAborted(options.signal);
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
    buffer = await fs.promises.readFile(filePath, {
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw manuscriptAbortError();
    throw new ManuscriptFileError(
      'unreadable',
      `Cannot read manuscript: ${error}`,
    );
  }
  // Recheck the bytes actually read: the file may have grown between stat/read.
  if (buffer.length > MANUSCRIPT_MAX_BYTES) {
    throw new ManuscriptFileError(
      'tooLarge',
      `Manuscript exceeds ${MANUSCRIPT_MAX_BYTES} bytes`,
    );
  }
  throwIfAborted(options.signal);
  const decoded = decodeManuscriptBuffer(buffer);
  const extension = path.extname(filePath).toLowerCase();
  const text = normalizeManuscriptText(
    decoded.text,
    extension === '.md' || extension === '.markdown',
  );
  const segmented = await segmentManuscriptWithMetrics(text, options.signal);
  if (!text || segmented.comparableCharacterCount === 0) {
    throw new ManuscriptFileError(
      'empty',
      'The manuscript contains no matchable text',
    );
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    text,
    units: segmented.units,
    size: buffer.length,
    encoding: decoded.encoding,
    characterCount: segmented.characterCount,
    comparableCharacterCount: segmented.comparableCharacterCount,
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

const MATCHABLE_CHARACTER = /[\p{L}\p{N}]/u;
const SOFT_SPLIT_CHARACTER = /[\s，,、：:]/u;

function comparableValues(rawCharacter: string): string[] {
  const values: string[] = [];
  const normalized = rawCharacter.normalize('NFKC').toLowerCase();
  for (const normalizedCharacter of normalized) {
    if (MATCHABLE_CHARACTER.test(normalizedCharacter)) {
      values.push(normalizedCharacter);
    }
  }
  return values;
}

function toComparableChars(text: string): ComparableChar[] {
  const chars: ComparableChar[] = [];
  const matcher = /./gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    // 不使用 toLocaleLowerCase：土耳其语等系统区域会让相同文件产生不同匹配结果。
    for (const normalizedChar of comparableValues(match[0])) {
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
  const symbols: string[] = [];
  for (const rawCharacter of text) {
    symbols.push(...comparableValues(rawCharacter));
  }
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

interface TextMetrics {
  characterCount: number;
  comparableCharacterCount: number;
}

interface SegmentedManuscript extends TextMetrics {
  units: string[];
}

async function measureText(
  text: string,
  signal?: AbortSignal,
): Promise<TextMetrics> {
  let characterCount = 0;
  let comparableCharacterCount = 0;
  let rawIndex = 0;
  let nextYield = YIELD_EVERY_OPERATIONS;
  for (const rawCharacter of text) {
    characterCount += 1;
    comparableCharacterCount += comparableValues(rawCharacter).length;
    if (comparableCharacterCount > MANUSCRIPT_MAX_COMPARABLE_CHARS) {
      throw new ManuscriptFileError(
        'tooComplex',
        `Manuscript exceeds ${MANUSCRIPT_MAX_COMPARABLE_CHARS} comparable characters`,
      );
    }
    rawIndex += rawCharacter.length;
    if (rawIndex >= nextYield) {
      await cooperativeYield(signal);
      nextYield = rawIndex + YIELD_EVERY_OPERATIONS;
    }
  }
  return { characterCount, comparableCharacterCount };
}

/**
 * Splits one long sentence in linear time. Comparable offsets and soft
 * boundaries are collected once; each subsequent cut advances monotonically.
 */
async function splitLongUnit(
  input: string,
  targetLength = 56,
  signal?: AbortSignal,
): Promise<string[]> {
  const text = input.trim();
  if (!text) return [];

  const comparableEnds: number[] = [];
  const boundaries: Array<{ comparableCount: number; rawEnd: number }> = [];
  let rawIndex = 0;
  let nextYield = YIELD_EVERY_OPERATIONS;
  for (const rawCharacter of text) {
    rawIndex += rawCharacter.length;
    for (const _value of comparableValues(rawCharacter)) {
      comparableEnds.push(rawIndex);
    }
    if (SOFT_SPLIT_CHARACTER.test(rawCharacter)) {
      boundaries.push({
        comparableCount: comparableEnds.length,
        rawEnd: rawIndex,
      });
    }
    if (rawIndex >= nextYield) {
      await cooperativeYield(signal);
      nextYield = rawIndex + YIELD_EVERY_OPERATIONS;
    }
  }

  const maxTailLength = Math.floor(targetLength * 1.5);
  if (comparableEnds.length <= maxTailLength) {
    return comparableEnds.length > 0 ? [text] : [];
  }

  const minimumOffset = Math.max(1, Math.floor(targetLength * 0.55));
  const maximumOffset = Math.max(minimumOffset, Math.ceil(targetLength * 1.35));
  const parts: string[] = [];
  let comparableStart = 0;
  let rawStart = 0;
  let boundaryStart = 0;
  let nextSplitYield = YIELD_EVERY_OPERATIONS;

  while (comparableEnds.length - comparableStart > maxTailLength) {
    const targetComparable = Math.min(
      comparableEnds.length,
      comparableStart + targetLength,
    );
    const minimumComparable = comparableStart + minimumOffset;
    const maximumComparable = Math.min(
      comparableEnds.length,
      comparableStart + maximumOffset,
    );
    while (
      boundaryStart < boundaries.length &&
      boundaries[boundaryStart].comparableCount <= comparableStart
    ) {
      boundaryStart += 1;
    }

    let bestBoundary: { comparableCount: number; rawEnd: number } | undefined;
    for (
      let boundaryIndex = boundaryStart;
      boundaryIndex < boundaries.length;
      boundaryIndex += 1
    ) {
      const boundary = boundaries[boundaryIndex];
      if (boundary.comparableCount > maximumComparable) break;
      if (boundary.comparableCount < minimumComparable) continue;
      if (
        !bestBoundary ||
        Math.abs(boundary.comparableCount - targetComparable) <
          Math.abs(bestBoundary.comparableCount - targetComparable)
      ) {
        bestBoundary = boundary;
      }
    }

    const rawCut =
      bestBoundary?.rawEnd ??
      comparableEnds[Math.max(comparableStart, targetComparable - 1)];
    if (!rawCut || rawCut <= rawStart) break;
    const head = text.slice(rawStart, rawCut).trim();
    if (head) parts.push(head);
    rawStart = rawCut;
    while (
      comparableStart < comparableEnds.length &&
      comparableEnds[comparableStart] <= rawCut
    ) {
      comparableStart += 1;
    }
    if (comparableStart >= nextSplitYield) {
      await cooperativeYield(signal);
      nextSplitYield = comparableStart + YIELD_EVERY_OPERATIONS;
    }
  }

  const tail = text.slice(rawStart).trim();
  if (tail) parts.push(tail);
  return parts;
}

async function segmentManuscriptWithMetrics(
  text: string,
  signal?: AbortSignal,
): Promise<SegmentedManuscript> {
  throwIfAborted(signal);
  const normalized = normalizeManuscriptText(text);
  const metrics = await measureText(normalized, signal);
  const units: string[] = [];

  const appendPiece = async (piece: string): Promise<void> => {
    for (const part of await splitLongUnit(piece, 56, signal)) {
      if (units.length >= MANUSCRIPT_MAX_UNITS) {
        throw new ManuscriptFileError(
          'tooComplex',
          `Manuscript exceeds ${MANUSCRIPT_MAX_UNITS} matching units`,
        );
      }
      units.push(part);
    }
  };

  let processed = 0;
  let nextYield = YIELD_EVERY_OPERATIONS;
  for (const paragraph of normalized.split(/\n+/)) {
    let start = 0;
    for (let index = 0; index < paragraph.length; index += 1) {
      const current = paragraph[index];
      const next = paragraph[index + 1] ?? '';
      const hardBoundary = /[。！？!?；;]/u.test(current);
      const englishPeriodBoundary =
        current === '.' && (!next || /\s/u.test(next));
      if (hardBoundary || englishPeriodBoundary) {
        const piece = paragraph.slice(start, index + 1).trim();
        if (piece) await appendPiece(piece);
        start = index + 1;
        while (start < paragraph.length && /\s/u.test(paragraph[start])) {
          start += 1;
        }
        index = start - 1;
      }
      processed += 1;
      if (processed >= nextYield) {
        await cooperativeYield(signal);
        nextYield = processed + YIELD_EVERY_OPERATIONS;
      }
    }
    const tail = paragraph.slice(start).trim();
    if (tail) await appendPiece(tail);
  }
  return { ...metrics, units };
}

export async function segmentManuscript(
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  return (await segmentManuscriptWithMetrics(text, options.signal)).units;
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

function orderedBigrams(value: string): string[] {
  const symbols = Array.from(value);
  if (symbols.length <= 1) return symbols;
  const grams = new Array<string>(symbols.length - 1);
  for (let index = 0; index + 1 < symbols.length; index += 1) {
    grams[index] = symbols[index] + symbols[index + 1];
  }
  return grams;
}

/**
 * Banded Levenshtein over the ordered bigram sequence. Dice is fast and useful
 * for candidate discovery, but its multiset representation cannot distinguish
 * reordered clauses. This gate restores order while limiting work to the edit
 * band implied by the current confidence threshold.
 */
function orderedBigramSimilarity(
  left: ComparableSequence,
  right: ComparableSequence,
  minimumSimilarity: number,
): number {
  if (left.value === right.value) return 1;
  const leftGrams = orderedBigrams(left.value);
  const rightGrams = orderedBigrams(right.value);
  const maximumComparableLength = Math.max(left.length, right.length);
  if (maximumComparableLength === 0) return 0;
  const maximumDistance = Math.floor(
    (1 - minimumSimilarity) * maximumComparableLength,
  );
  if (Math.abs(leftGrams.length - rightGrams.length) > maximumDistance) {
    return 0;
  }

  const infinity =
    maximumDistance + Math.max(leftGrams.length, rightGrams.length) + 1;
  let previous = new Int32Array(rightGrams.length + 1);
  let current = new Int32Array(rightGrams.length + 1);
  previous.fill(infinity);
  for (
    let index = 0;
    index <= Math.min(rightGrams.length, maximumDistance);
    index += 1
  ) {
    previous[index] = index;
  }

  for (let leftIndex = 1; leftIndex <= leftGrams.length; leftIndex += 1) {
    current.fill(infinity);
    if (leftIndex <= maximumDistance) current[0] = leftIndex;
    const from = Math.max(1, leftIndex - maximumDistance);
    const to = Math.min(rightGrams.length, leftIndex + maximumDistance);
    let rowMinimum = infinity;
    for (let rightIndex = from; rightIndex <= to; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        (leftGrams[leftIndex - 1] === rightGrams[rightIndex - 1] ? 0 : 1);
      const distance = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maximumDistance) return 0;
    [previous, current] = [current, previous];
  }

  const distance = previous[rightGrams.length];
  return distance <= maximumDistance
    ? 1 - distance / maximumComparableLength
    : 0;
}

function uniqueNgramPositions(
  value: string,
  size: number,
): Map<string, number> {
  const symbols = Array.from(value);
  const positions = new Map<string, number | null>();
  for (let index = 0; index + size <= symbols.length; index += 1) {
    const gram = symbols.slice(index, index + size).join('');
    positions.set(gram, positions.has(gram) ? null : index);
  }
  const unique = new Map<string, number>();
  positions.forEach((position, gram) => {
    if (position !== null) unique.set(gram, position);
  });
  return unique;
}

/**
 * A real local swap supplies two directional anchors: an earlier source anchor
 * moves right in the manuscript, a later source anchor moves left, and their
 * mapped order crosses. A single coincidental anchor or monotonic ASR edits
 * cannot satisfy that pair. Bigrams catch swapped two-character words while
 * trigrams provide a stronger fallback when a bigram is repeated elsewhere.
 * Single-character anchors are intentionally excluded because two ordinary
 * substitutions are indistinguishable from swapping two isolated characters.
 */
function hasDirectionalUniqueNgramCrossing(
  left: ComparableSequence,
  right: ComparableSequence,
  size: number,
): boolean {
  const leftPositions = uniqueNgramPositions(left.value, size);
  const rightPositions = uniqueNgramPositions(right.value, size);
  const anchors = Array.from(leftPositions.entries())
    .map(([gram, leftPosition]) => ({
      leftPosition,
      rightPosition: rightPositions.get(gram),
    }))
    .filter(
      (anchor): anchor is { leftPosition: number; rightPosition: number } =>
        anchor.rightPosition !== undefined,
    )
    .sort((leftAnchor, rightAnchor) => {
      return leftAnchor.leftPosition - rightAnchor.leftPosition;
    });

  let furthestRightMovingPosition = -1;
  for (const anchor of anchors) {
    const displacement = anchor.rightPosition - anchor.leftPosition;
    if (
      displacement <= -MIN_REORDER_ANCHOR_DISPLACEMENT &&
      furthestRightMovingPosition > anchor.rightPosition
    ) {
      return true;
    }
    if (displacement >= MIN_REORDER_ANCHOR_DISPLACEMENT) {
      furthestRightMovingPosition = Math.max(
        furthestRightMovingPosition,
        anchor.rightPosition,
      );
    }
  }
  return false;
}

function hasSupportedLocalReordering(
  left: ComparableSequence,
  right: ComparableSequence,
): boolean {
  return REORDER_NGRAM_SIZES.some((size) => {
    return hasDirectionalUniqueNgramCrossing(left, right, size);
  });
}

/**
 * Exact one-character insertion, deletion, or substitution, computed in
 * linear time. Requiring at least ten characters on the shorter side keeps
 * very short utterances from receiving an overly permissive one-edit budget.
 */
function singleCharacterEditSimilarity(
  left: ComparableSequence,
  right: ComparableSequence,
): number | null {
  if (Math.abs(left.length - right.length) > 1) return null;
  if (Math.min(left.length, right.length) < MIN_SINGLE_CHARACTER_EDIT_LENGTH) {
    return null;
  }
  if (left.length === right.length) {
    const leftSymbols = Array.from(left.value);
    const rightSymbols = Array.from(right.value);
    let mismatches = 0;
    for (let index = 0; index < leftSymbols.length; index += 1) {
      if (leftSymbols[index] !== rightSymbols[index]) {
        mismatches += 1;
        if (mismatches > 1) return null;
      }
    }
    return mismatches === 1 ? 1 - 1 / left.length : null;
  }
  const shorter = Array.from(
    left.length < right.length ? left.value : right.value,
  );
  const longer = Array.from(
    left.length < right.length ? right.value : left.value,
  );
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) return null;
    skipped = true;
    longerIndex += 1;
  }
  // With a one-character length difference, an unmatched trailing character
  // is the single edit when no earlier skip was needed.
  return 1 - 1 / longer.length;
}

function safeSimilarity(
  left: ComparableSequence,
  right: ComparableSequence,
  threshold: number,
): number {
  if (left.value === right.value) return 1;
  const unordered = diceSimilarity(left, right);
  const singleCharacterEdit = singleCharacterEditSimilarity(left, right);
  if (singleCharacterEdit !== null) {
    return Math.max(unordered, singleCharacterEdit);
  }
  // Position maps are only built for viable candidates. Ordinary
  // low-confidence pairs leave through this fast path.
  if (unordered < threshold) return unordered;
  if (hasSupportedLocalReordering(left, right)) return 0;
  const ordered = orderedBigramSimilarity(left, right, threshold);
  if (unordered - ordered > MAX_UNORDERED_ORDERED_GAP) return 0;
  return Math.min(unordered, ordered);
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

async function buildTrigramIndex(
  units: ManuscriptUnit[],
  signal?: AbortSignal,
): Promise<Map<string, number[]>> {
  const index = new Map<string, number[]>();
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    for (const gram of uniqueTrigrams(unit.comparable.value)) {
      const positions = index.get(gram) ?? [];
      if (positions.length < MAX_INDEXED_POSITIONS) positions.push(unitIndex);
      index.set(gram, positions);
    }
    if ((unitIndex + 1) % 256 === 0) await cooperativeYield(signal);
  }
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
export async function matchManuscriptToCues<T extends ManuscriptMatchCue>(
  inputCues: T[],
  manuscriptText: string,
  options: ManuscriptMatchOptions = {},
): Promise<ManuscriptMatchResult<T>> {
  throwIfAborted(options.signal);
  await cooperativeYield(options.signal);
  const cues = inputCues.map((cue) => ({ ...cue }));
  const segmentedUnits =
    options.manuscriptUnits ??
    (await segmentManuscript(manuscriptText, { signal: options.signal }));
  if (segmentedUnits.length > MANUSCRIPT_MAX_UNITS) {
    throw new ManuscriptFileError(
      'tooComplex',
      `Manuscript exceeds ${MANUSCRIPT_MAX_UNITS} matching units`,
    );
  }
  const manuscriptUnits: ManuscriptUnit[] = [];
  for (let index = 0; index < segmentedUnits.length; index += 1) {
    const text = segmentedUnits[index];
    manuscriptUnits.push({ text, comparable: makeComparable(text) });
    if ((index + 1) % 256 === 0) await cooperativeYield(options.signal);
  }
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
  const trigramIndex = await buildTrigramIndex(manuscriptUnits, options.signal);

  let cueIndex = 0;
  let manuscriptCursor = 0;
  let confidenceTotal = 0;
  let comparisonsSinceYield = 0;
  while (cueIndex < cues.length && manuscriptCursor < manuscriptUnits.length) {
    throwIfAborted(options.signal);
    if (cueIndex > 0 && cueIndex % 8 === 0) {
      await cooperativeYield(options.signal);
    }
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
      const threshold = manuscriptConfidenceThreshold(cueComparable.length);
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
          const similarity = safeSimilarity(
            cueComparable,
            referenceComparable,
            threshold,
          );
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
          comparisonsSinceYield += 1;
          if (comparisonsSinceYield >= 64) {
            await cooperativeYield(options.signal);
            comparisonsSinceYield = 0;
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
    if (cueIndex % 16 === 0) await cooperativeYield(options.signal);
  }

  result.averageConfidence =
    result.replacedCues > 0
      ? roundConfidence(confidenceTotal / result.replacedCues)
      : 0;
  return result;
}

interface RawLineSpan {
  text: string;
  start: number;
  end: number;
}

function rawLineSpans(block: string): RawLineSpan[] {
  const lines: RawLineSpan[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineBreak.exec(block))) {
    lines.push({
      text: block.slice(start, match.index),
      start,
      end: match.index,
    });
    start = match.index + match[0].length;
  }
  if (start < block.length) {
    lines.push({ text: block.slice(start), start, end: block.length });
  }
  return lines;
}

/**
 * Replaces only selected cue text spans in an SRT string. Sequence identifiers,
 * timing lines, separators, line endings, and every unmatched cue remain byte
 * for byte identical.
 */
export function replaceMatchedSrtCueTexts(
  originalSrt: string,
  replacements: ReadonlyMap<number, string>,
): string {
  if (replacements.size === 0) return originalSrt;
  const parts = originalSrt.split(/((?:\r?\n){2,}|\r{2,})/);
  let cueIndex = 0;
  let applied = 0;

  for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
    const block = parts[partIndex];
    const lines = rawLineSpans(block);
    const nonEmptyLines = lines.filter((line) => line.text.trim() !== '');
    const timingIndex = nonEmptyLines.findIndex((line) =>
      line.text.includes('-->'),
    );
    if (timingIndex < 0) continue;
    const textLines = nonEmptyLines.slice(timingIndex + 1);
    if (textLines.length === 0) continue;

    const replacement = replacements.get(cueIndex);
    if (replacement !== undefined) {
      const firstTextLine = textLines[0];
      const lastTextLine = textLines[textLines.length - 1];
      parts[partIndex] =
        block.slice(0, firstTextLine.start) +
        replacement +
        block.slice(lastTextLine.end);
      applied += 1;
    }
    cueIndex += 1;
  }

  if (applied !== replacements.size) {
    throw new Error(
      `Could not safely locate all matched SRT cues (${applied}/${replacements.size})`,
    );
  }
  return parts.join('');
}
