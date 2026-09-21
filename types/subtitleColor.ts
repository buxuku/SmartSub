export interface SubtitleColor {
  red: number;
  green: number;
  blue: number;
  opacity: number;
}

/** The same complete color grammar is used by validation, CSS previews and ASS. */
export function parseSubtitleColor(value: string): SubtitleColor | undefined {
  if (/^#[0-9a-f]{6}$/i.test(value))
    return {
      red: parseInt(value.slice(1, 3), 16),
      green: parseInt(value.slice(3, 5), 16),
      blue: parseInt(value.slice(5, 7), 16),
      opacity: 1,
    };
  const match =
    /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value) ||
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/i.exec(
      value,
    );
  if (!match) return undefined;
  const [red, green, blue] = match.slice(1, 4).map(Number);
  if (![red, green, blue].every((channel) => channel <= 255)) return undefined;
  return { red, green, blue, opacity: Number(match[4] ?? 1) };
}

/** Native color inputs accept only hex, even when the adjacent text uses rgba. */
export function subtitleColorSwatch(value: string): string {
  const color = parseSubtitleColor(value);
  if (!color) return '#000000';
  return (
    '#' +
    [color.red, color.green, color.blue]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')
  );
}
