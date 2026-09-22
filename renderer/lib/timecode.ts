/** Parse clock time or legacy seconds without accepting invalid clock fields. */
export function parseTimecode(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(Math.round(seconds * 1000)) ? seconds : null;
  }
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] || '').padEnd(3, '0'));
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  if (minutes >= 60 || seconds >= 60 || !Number.isSafeInteger(total))
    return null;
  return total / 1000;
}

/** Round before splitting to carry milliseconds into seconds/minutes correctly. */
export function formatTimecode(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const wholeSeconds = Math.floor((total % 60000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}
