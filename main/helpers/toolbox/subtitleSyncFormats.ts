import {
  formatAssTime,
  formatVttTime,
  parseTimeToMs,
  type SubtitleCue,
} from '../subtitleFormats';

type CueTiming = Pick<SubtitleCue, 'startMs' | 'endMs'>;
type ShiftTiming = (timing: CueTiming) => CueTiming | undefined;

const TIME = String.raw`(?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?`;
const VTT_TIMING_LINE = new RegExp(
  `^([ \\t]*)(${TIME})([ \\t]*-->[ \\t]*)(${TIME})(?=[ \\t]|$)(.*)$`,
);
const ASS_TIME_FIELD = new RegExp(`^([ \\t]*)(${TIME})([ \\t]*)$`);

function retimeVtt(text: string, shift: ShiftTiming) {
  // Keep the original newline tokens, so everything except cue times survives.
  const lines = text.split(/(\r\n|\n|\r)/);
  let cuesCount = 0;

  for (let i = 0; i < lines.length; ) {
    const start = i;
    while (i < lines.length && lines[i].trim()) i += 2;
    const end = i;
    i += 2;
    if (start === end) continue;

    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[start].trim())) {
      continue;
    }

    // A cue can start with an identifier, but its text can also contain
    // timestamp-looking strings, so never scan beyond the first two lines.
    let timingIndex = start;
    let match = VTT_TIMING_LINE.exec(lines[start]);
    if (!match && start + 2 < end) {
      timingIndex = start + 2;
      match = VTT_TIMING_LINE.exec(lines[timingIndex]);
    }
    if (!match) continue;

    const [, leading, startTime, arrow, endTime, settings] = match;
    const startMs = parseTimeToMs(startTime);
    const endMs = parseTimeToMs(endTime);
    const next = shift({ startMs, endMs });
    if (!next) {
      for (let line = start; line < end; line++) lines[line] = '';
      continue;
    }

    const format = (time: number, original: string) => {
      const formatted = formatVttTime(time);
      return original.split(':').length === 2 && formatted.startsWith('00:')
        ? formatted.slice(3)
        : formatted;
    };
    lines[timingIndex] =
      leading +
      (next.startMs === startMs ? startTime : format(next.startMs, startTime)) +
      arrow +
      (next.endMs === endMs ? endTime : format(next.endMs, endTime)) +
      settings;
    cuesCount++;
  }

  return { text: lines.join(''), cuesCount };
}

function retimeAss(text: string, shift: ShiftTiming) {
  const lines = text.split(/(\r\n|\n|\r)/);
  let inEvents = false;
  let fields: string[] = [];
  let cuesCount = 0;

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inEvents = /^\s*\[events\]\s*$/i.test(line);
      fields = [];
      continue;
    }
    if (!inEvents) continue;

    const format = /^\s*Format\s*:(.*)$/i.exec(line);
    if (format) {
      fields = format[1].split(',').map((field) => field.trim().toLowerCase());
      continue;
    }

    const dialogue = /^(\s*Dialogue\s*:)(.*)$/i.exec(line);
    const start = fields.indexOf('start');
    const end = fields.indexOf('end');
    const textIndex = fields.indexOf('text');
    if (!dialogue || start < 0 || end < 0 || textIndex !== fields.length - 1) {
      continue;
    }

    // The final Text field may contain commas. Splitting and joining keeps its
    // bytes intact, and the preceding columns retain their original indexes.
    const values = dialogue[2].split(',');
    if (values.length < fields.length) continue;
    const startTime = ASS_TIME_FIELD.exec(values[start]);
    const endTime = ASS_TIME_FIELD.exec(values[end]);
    if (!startTime || !endTime) continue;

    const startMs = parseTimeToMs(startTime[2]);
    const endMs = parseTimeToMs(endTime[2]);
    const next = shift({ startMs, endMs });
    if (!next) {
      lines[i] = '';
      if (i + 1 < lines.length) lines[i + 1] = '';
      continue;
    }

    if (next.startMs !== startMs)
      values[start] = startTime[1] + formatAssTime(next.startMs) + startTime[3];
    if (next.endMs !== endMs)
      values[end] = endTime[1] + formatAssTime(next.endMs) + endTime[3];
    lines[i] = dialogue[1] + values.join(',');
    cuesCount++;
  }

  return { text: lines.join(''), cuesCount };
}

/** Edit cue times without converting format-specific markup to plain text. */
export function retimeFormattedSubtitle(
  text: string,
  format: 'vtt' | 'ass',
  shift: ShiftTiming,
) {
  return format === 'vtt' ? retimeVtt(text, shift) : retimeAss(text, shift);
}
