import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { promisify } from 'util';
import { TranscriptionResult, TranscriptionSegment } from '../../../types';

const execFileAsync = promisify(execFile);

function pad(number: number, size = 2): string {
  return String(Math.max(0, Math.floor(number))).padStart(size, '0');
}

export function formatSrtTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${pad(milliseconds, 3)}`;
}

function normalizeDuplicateText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

export function isLikelyDuplicateSegment(
  segment: TranscriptionSegment,
  previous: TranscriptionSegment,
): boolean {
  const text = normalizeDuplicateText(segment.text || '');
  const previousText = normalizeDuplicateText(previous.text || '');

  if (text.length < 8 || previousText.length < 8) return false;
  return text === previousText && segment.start <= previous.end + 2;
}

export function normalizeTranscriptionSegments(
  segments: TranscriptionSegment[],
): TranscriptionSegment[] {
  const prepared = segments
    .filter((segment) => segment.text?.trim())
    .map((segment) => ({
      ...segment,
      start: Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0,
      end: Number.isFinite(segment.end) ? Math.max(0, segment.end) : 0,
      text: segment.text.trim(),
    }))
    .sort((a, b) => a.start - b.start);

  const normalized: TranscriptionSegment[] = [];

  for (let index = 0; index < prepared.length; index++) {
    const segment = { ...prepared[index] };
    const next = prepared[index + 1];

    segment.end = Math.max(segment.end, segment.start + 0.5);
    if (next && Number.isFinite(next.start) && next.start > segment.start) {
      segment.end = Math.min(
        segment.end,
        Math.max(segment.start + 0.5, next.start - 0.05),
      );
    }

    const previous = normalized[normalized.length - 1];
    if (previous && isLikelyDuplicateSegment(segment, previous)) {
      continue;
    }

    if (previous && segment.start < previous.end) {
      segment.start = previous.end;
      segment.end = Math.max(segment.end, segment.start + 0.5);
    }

    normalized.push(segment);
  }

  return normalized;
}

export function formatSegmentsAsSrt(segments: TranscriptionSegment[]): string {
  return normalizeTranscriptionSegments(segments)
    .map((segment, index) => {
      return `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(
        Math.max(segment.end, segment.start + 0.5),
      )}\n${segment.text.trim()}\n\n`;
    })
    .join('');
}

function splitTranscriptionText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentenceMatches = normalized.match(/[^。！？!?]+[。！？!?]?/g) || [
    normalized,
  ];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentenceMatches) {
    const next = `${current}${sentence}`.trim();
    if (next.length > 42 && current) {
      chunks.push(current.trim());
      current = sentence.trim();
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [normalized];
}

export function makeApproximateSegments(
  text: string,
  durationSeconds: number,
): TranscriptionSegment[] {
  const chunks = splitTranscriptionText(text);
  if (chunks.length === 0) return [];

  const safeDuration = Math.max(durationSeconds || chunks.length * 4, 1);
  const totalWeight = chunks.reduce(
    (total, chunk) => total + Math.max(chunk.length, 1),
    0,
  );
  let cursor = 0;

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const weight = Math.max(chunk.length, 1) / totalWeight;
    const segmentDuration = isLast
      ? Math.max(0.8, safeDuration - cursor)
      : safeDuration * weight;
    const start = cursor;
    const end = isLast
      ? safeDuration
      : Math.max(start + 0.8, start + segmentDuration);
    cursor = end;
    return {
      start,
      end,
      text: chunk,
    };
  });
}

export async function getAudioDurationSeconds(
  audioPath: string,
): Promise<number> {
  const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

  try {
    await execFileAsync(ffmpegPath, ['-i', audioPath]);
  } catch (error: any) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`;
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;

    const [, hours, minutes, seconds] = match;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds || 0);
  }

  return 0;
}

export async function formatTranscriptionResultAsSrt(
  result: TranscriptionResult,
  audioPath: string,
): Promise<string> {
  if (result.segments?.length) {
    return formatSegmentsAsSrt(result.segments);
  }

  const duration = await getAudioDurationSeconds(audioPath);
  return formatSegmentsAsSrt(makeApproximateSegments(result.text, duration));
}
