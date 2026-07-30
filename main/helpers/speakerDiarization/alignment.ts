/**
 * 说话者分离结果与字幕 cue 的纯函数对齐。
 *
 * sherpa 返回的是按秒计时的说话者片段；字幕内部统一用毫秒。对每条字幕按
 * 时间重叠累计每位说话者的覆盖时长，主说话者取覆盖最长者。若第二位说话者
 * 也覆盖了足够长的区间，则保留为重叠说话者，避免把多人同时说话静默归给一人。
 */

export interface SpeakerDiarizationSegment {
  start: number;
  end: number;
  speaker: number;
}

export interface TimedSubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SpeakerAssignment {
  /** sherpa 的零基 speaker id，按本 cue 的覆盖时长降序排列。 */
  speakers: number[];
  /** 所有有效分离片段对本 cue 的覆盖时长（秒）。 */
  coveredSeconds: number;
}

export interface SpeakerAlignmentOptions {
  /** 至少覆盖 cue 的这一比例才认为匹配有效。 */
  minCoverageRatio?: number;
  /** 至少覆盖这么多秒才认为匹配有效。 */
  minCoverageSeconds?: number;
  /** 次说话者相对主说话者达到这一比例时标为重叠。 */
  overlapRelativeRatio?: number;
  /** 次说话者至少覆盖这么多秒才标为重叠。 */
  overlapMinSeconds?: number;
}

const DEFAULT_OPTIONS: Required<SpeakerAlignmentOptions> = {
  minCoverageRatio: 0.08,
  minCoverageSeconds: 0.08,
  overlapRelativeRatio: 0.3,
  overlapMinSeconds: 0.18,
};

const SPEAKER_PREFIX = /^\[Speaker\s+\d+(?:\s*\+\s*Speaker\s+\d+)*\]\s*/i;

/**
 * 移除本功能写入的说话者前缀。该函数同时供字幕重试幂等处理与 TTS 文本边界使用；
 * 其它方括号文本（例如舞台提示）保持不变。
 */
export function stripSpeakerLabelPrefix(text: string): string {
  return (text || '').replace(SPEAKER_PREFIX, '');
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function normalizeDiarizationSegments(
  segments: SpeakerDiarizationSegment[],
): SpeakerDiarizationSegment[] {
  return (segments || [])
    .filter(
      (segment) =>
        finiteNonNegative(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start &&
        Number.isInteger(segment.speaker) &&
        segment.speaker >= 0,
    )
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function alignSpeakersToCues(
  cues: TimedSubtitleCue[],
  rawSegments: SpeakerDiarizationSegment[],
  options: SpeakerAlignmentOptions = {},
): SpeakerAssignment[] {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const segments = normalizeDiarizationSegments(rawSegments);

  return cues.map((cue) => {
    const start = Math.max(0, cue.startMs / 1000);
    const end = Math.max(start, cue.endMs / 1000);
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0) {
      return { speakers: [], coveredSeconds: 0 };
    }

    const overlapBySpeaker = new Map<number, number>();
    for (const segment of segments) {
      if (segment.end <= start) continue;
      if (segment.start >= end) break;
      const overlap = Math.max(
        0,
        Math.min(end, segment.end) - Math.max(start, segment.start),
      );
      if (overlap <= 0) continue;
      overlapBySpeaker.set(
        segment.speaker,
        (overlapBySpeaker.get(segment.speaker) || 0) + overlap,
      );
    }

    const ranked = Array.from(overlapBySpeaker.entries()).sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const primary = ranked[0];
    if (!primary) return { speakers: [], coveredSeconds: 0 };

    const [primarySpeaker, primarySeconds] = primary;
    const minimumPrimary = Math.max(
      config.minCoverageSeconds,
      duration * config.minCoverageRatio,
    );
    if (primarySeconds < minimumPrimary) {
      return {
        speakers: [],
        coveredSeconds: ranked.reduce((sum, [, seconds]) => sum + seconds, 0),
      };
    }

    const speakers = [primarySpeaker];
    for (const [speaker, seconds] of ranked.slice(1)) {
      if (
        seconds >= config.overlapMinSeconds &&
        seconds >= primarySeconds * config.overlapRelativeRatio
      ) {
        speakers.push(speaker);
      }
    }

    return {
      speakers,
      coveredSeconds: ranked.reduce((sum, [, seconds]) => sum + seconds, 0),
    };
  });
}

export function speakerLabel(speakers: number[]): string {
  return speakers
    .map((speaker) => `Speaker ${Math.max(0, Math.trunc(speaker)) + 1}`)
    .join(' + ');
}

/**
 * 为字幕添加稳定、语言中立的可读前缀。未知说话者不改文本；重复执行会先移除
 * 本功能写入的旧前缀，保证重试/重新对齐幂等。
 */
export function annotateCuesWithSpeakers(
  cues: TimedSubtitleCue[],
  segments: SpeakerDiarizationSegment[],
  options?: SpeakerAlignmentOptions,
): TimedSubtitleCue[] {
  const assignments = alignSpeakersToCues(cues, segments, options);
  return cues.map((cue, index) => {
    const text = stripSpeakerLabelPrefix(cue.text || '');
    const speakers = assignments[index]?.speakers || [];
    if (speakers.length === 0) return { ...cue, text };
    return {
      ...cue,
      text: `[${speakerLabel(speakers)}] ${text}`.trimEnd(),
    };
  });
}
