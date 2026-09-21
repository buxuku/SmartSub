import { createHash } from 'crypto';

export interface AssEmbeddedFont {
  name: string;
  id: string;
  data: Buffer;
}

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FONTS = 64;

function sectionHeading(line: string, next = ''): string | undefined {
  const heading = /^\s*\[([^\]\r\n]+)\]\s*$/.exec(line);
  // ASS attachment bytes can look like [AB]. Preserve ambiguous encoded rows.
  if (
    heading &&
    (/[\x00-\x20\x61-\uffff]/.test(heading[1]) ||
      (/[^\x21-\x60]/.test(next) && !/^fontname:/i.test(next)) ||
      /^(SCRIPT INFO|V4\+? STYLES|EVENTS|FONTS|GRAPHICS)$/i.test(heading[1]))
  )
    return line.trim().toLowerCase();
}

/** libass reads unknown extension metadata as attachment bytes unless fonts end the file. */
export function normalizeAssFontSections(content: string): string {
  const lines = content.split(/\r?\n|\r/);
  const retained: string[] = [],
    fonts: string[] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const heading = sectionHeading(lines[i], lines[i + 1]);
    if (heading) {
      section = heading;
      if (heading === '[fonts]') continue;
    }
    (section === '[fonts]' ? fonts : retained).push(lines[i]);
  }
  if (!fonts.length) return content;
  while (retained.at(-1) === '') retained.pop();
  while (fonts.at(-1) === '') fonts.pop();
  return retained.join('\n') + '\n\n[Fonts]\n' + fonts.join('\n') + '\n';
}

/** ASS uses unpadded six-bit encoding offset by 33, not MIME base64. */
function decodeFont(encoded: string): Buffer {
  if (
    !encoded.length ||
    encoded.length % 4 === 1 ||
    /[^\x21-\x60]/.test(encoded)
  )
    throw new Error('Invalid ASS embedded font encoding');
  const size = Math.floor((encoded.length * 3) / 4);
  if (size > MAX_FONT_BYTES)
    throw new Error('ASS embedded font exceeds 32 MiB');
  const data = Buffer.alloc(size);
  let output = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const count = Math.min(4, encoded.length - offset);
    let value = 0;
    for (let i = 0; i < count; i++)
      value |= (encoded.charCodeAt(offset + i) - 33) << (18 - i * 6);
    data[output++] = value >>> 16;
    if (count >= 3) data[output++] = (value >>> 8) & 255;
    if (count === 4) data[output++] = value & 255;
  }
  return data;
}

export function readAssEmbeddedFonts(content: string): AssEmbeddedFont[] {
  const fonts: AssEmbeddedFont[] = [];
  let section = '';
  let name: string | null = null;
  let chunks: string[] = [];
  let length = 0;
  let total = 0;
  const flush = () => {
    if (name === null) return;
    if (
      total + Math.floor((length * 3) / 4) > MAX_TOTAL_BYTES ||
      fonts.length >= MAX_FONTS
    )
      throw new Error('ASS embedded fonts exceed the document limit');
    const data = decodeFont(chunks.join(''));
    total += data.length;
    if (total > MAX_TOTAL_BYTES || fonts.length >= MAX_FONTS)
      throw new Error('ASS embedded fonts exceed the document limit');
    fonts.push({
      name,
      data,
      id: createHash('sha256').update(data).digest('hex'),
    });
    name = null;
    chunks = [];
    length = 0;
  };
  const lines = content.split(/\r?\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = sectionHeading(line, lines[index + 1]);
    if (heading) {
      flush();
      section = heading;
      continue;
    }
    if (section !== '[fonts]') continue;
    const header = /^fontname:\s*(.*)$/i.exec(line);
    if (header) {
      flush();
      name = header[1].trim();
      if (!name) throw new Error('ASS embedded font has no name');
    } else if (name !== null && line.length) {
      length += line.length;
      if (length > Math.ceil((MAX_FONT_BYTES * 4) / 3))
        throw new Error('ASS embedded font exceeds 32 MiB');
      chunks.push(line);
    }
  }
  flush();
  return fonts;
}
