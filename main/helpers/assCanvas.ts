import type { SubtitleStyle } from '../../types/subtitleMerge';
import {
  absoluteSubtitleY,
  assEventPositionY,
  assEventAlignment,
  assMarginPositionY,
} from '../../types/subtitleCanvas';
import {
  buildAssStyleLine,
  assGlowText,
  assPrimaryColorTags,
} from './assStyleBuilder';
import { subtitleGlow, subtitleTextRuns } from '../../types/subtitleAppearance';
import {
  mapAssOverrideBlocks,
  mapAssOverrideTags,
} from '../../types/assOverrides';

const STYLE_FIELDS =
  'Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding'
    .toLowerCase()
    .split(',');
const CONTROLLED = new Set([
  'fontname',
  'fontsize',
  'primarycolour',
  'outlinecolour',
  'backcolour',
  'bold',
  'italic',
  'underline',
  'borderstyle',
  'outline',
  'shadow',
  'alignment',
  'marginl',
  'marginr',
  'marginv',
]);
const EVENT_FIELDS =
  'layer,start,end,style,name,marginl,marginr,marginv,effect,text'.split(',');
const SSA_FIELDS =
  'name,fontname,fontsize,primarycolour,secondarycolour,tertiarycolour,backcolour,bold,italic,borderstyle,outline,shadow,alignment,marginl,marginr,marginv,alphalevel,encoding'.split(
    ',',
  );

function appearanceText(text: string, style: SubtitleStyle): string {
  if (
    !style.secondLineColor &&
    !style.highlightTerms?.some((term) => term.trim())
  )
    return text;
  let drawing = false;
  let line = 0;
  const tokens = text.split(/(\{[^}]*\}|\\[Nnh])/g);
  let visible: { index: number; text: string }[] = [];
  const flush = () => {
    if (!visible.length) return;
    // Match complete visible words across overrides, then map colors back onto
    // their original spans. Override order and non-text drawing data stay intact.
    const runs = subtitleTextRuns(visible.map((token) => token.text).join(''), {
      ...style,
      primaryColor:
        line > 0 && style.secondLineColor
          ? style.secondLineColor
          : style.primaryColor,
      secondLineColor: undefined,
    });
    let runIndex = 0;
    let runOffset = 0;
    for (const token of visible) {
      let offset = 0;
      let result = '';
      while (offset < token.text.length) {
        const run = runs[runIndex];
        const length = Math.min(
          run.text.length - runOffset,
          token.text.length - offset,
        );
        result +=
          assPrimaryColorTags(run.color) +
          (tokens[token.index] === '\\h'
            ? '\\h'
            : token.text.slice(offset, offset + length));
        offset += length;
        runOffset += length;
        if (runOffset === run.text.length) {
          runIndex++;
          runOffset = 0;
        }
      }
      tokens[token.index] = result;
    }
    visible = [];
  };
  tokens.forEach((token, index) => {
    if (!token) return;
    if (token.startsWith('{')) {
      mapAssOverrideBlocks(token, (tag) => {
        const mode = /^\\p(\d+)\s*$/.exec(tag);
        const next = mode
          ? Number(mode[1]) > 0
          : tag.startsWith('\\r')
            ? false
            : drawing;
        if (next !== drawing) flush();
        drawing = next;
        return tag;
      });
    } else if (!drawing && /^\\[Nn]$/.test(token)) {
      flush();
      line++;
    } else if (!drawing) {
      visible.push({ index, text: token === '\\h' ? '\u00a0' : token });
    }
  });
  flush();
  return tokens.join('');
}

const rounded = (value: number) => Number(value.toFixed(3));

function shiftCoordinates(tag: string, delta: number): string {
  if (/^\\t\(/i.test(tag)) {
    const start = tag.indexOf('(') + 1;
    const end = tag.lastIndexOf(')');
    return (
      tag.slice(0, start) +
      mapAssOverrideTags(tag.slice(start, end), (nested) =>
        shiftCoordinates(nested, delta),
      ) +
      tag.slice(end)
    );
  }
  const match = /^\\(pos|move|org|i?clip)\(([^)]*)\)\s*$/i.exec(tag);
  if (!match) return tag;
  const [, kind, body] = match;
  const name = kind.toLowerCase();
  const numbers = body.split(',').map((value) => Number(value.trim()));
  const count = /^(pos|org)$/.test(name) ? [2] : name === 'move' ? [4, 6] : [4];
  if (numbers.every(Number.isFinite) && count.includes(numbers.length)) {
    numbers[1] = rounded(numbers[1] + delta);
    if (numbers.length >= 4) numbers[3] = rounded(numbers[3] + delta);
    return `\\${kind}(${numbers.join(',')})`;
  }
  if (!/clip$/.test(name)) return tag;
  const vector = /^(?:(\d+)\s*,\s*)?([mnlbspc\s\d.+-]+)$/i.exec(body.trim());
  if (!vector || !/^m\s/i.test(vector[2])) return tag;
  const scale = Number(vector[1] || 1);
  if (scale < 1 || scale > 30) return tag;
  let coordinate = 0;
  let valid = true;
  const tokens = vector[2]
    .trim()
    .split(/\s+/)
    .map((token) => {
      if (/^[mnlbspc]$/i.test(token)) {
        if (coordinate % 2) valid = false;
        coordinate = 0;
        return token;
      }
      const value = Number(token);
      if (!Number.isFinite(value)) valid = false;
      return String(
        rounded(value + (coordinate++ % 2 ? delta * 2 ** (scale - 1) : 0)),
      );
    });
  if (!valid || coordinate % 2) return tag;
  return `\\${kind}(${vector[1] ? `${scale},` : ''}${tokens.join(' ')})`;
}

function moveVertically(
  text: string,
  effect: string,
  style: SubtitleStyle,
  resX: number,
  resY: number,
  referenceY: number,
): { text: string; effect?: string; marginV?: number } {
  const positionY = absoluteSubtitleY(style);
  if (positionY === undefined) return { text };
  const delta = ((positionY - referenceY) * resY) / 100;
  if (Math.abs(delta) < 0.00001) return { text, marginV: style.marginV };
  let positioned = false;
  const alignment = assEventAlignment(text, style.alignment);
  const updated = mapAssOverrideBlocks(text, (tag) => {
    const position = /^\\(pos|move)\(([^)]*)\)\s*$/i.exec(tag);
    if (position) {
      const [, kind, values] = position;
      const numbers = values.split(',').map((value) => Number(value.trim()));
      if (
        !numbers.every(Number.isFinite) ||
        (kind.toLowerCase() === 'pos'
          ? numbers.length !== 2
          : ![4, 6].includes(numbers.length))
      )
        return tag;
      positioned = true;
    }
    return shiftCoordinates(tag, delta);
  });
  const scroll = /^(Scroll (?:up|down);)(-?\d+);(-?\d+)(;\s*\d+(?:;.*)?)$/.exec(
    effect,
  );
  if (scroll)
    return {
      text: updated,
      effect: `${scroll[1]}${Math.round(Number(scroll[2]) + delta)};${Math.round(Number(scroll[3]) + delta)}${scroll[4]}`,
      marginV: style.marginV,
    };
  if (positioned) return { text: updated, marginV: style.marginV };
  const column = (alignment - 1) % 3;
  const x =
    column === 0
      ? style.marginL
      : column === 1
        ? resX / 2
        : resX - style.marginR;
  const row = Math.floor((alignment - 1) / 3);
  const marginV = style.marginV + (row === 0 ? -delta : delta);
  // Keep collision placement at zero margin; the planner handles negative margins
  // with layer translation because libass clips before resolving collisions.
  if (row !== 1) return { text: updated, marginV: Math.round(marginV) };
  const y = (assMarginPositionY(text, style, resY) * resY) / 100 + delta;
  return { text: `{\\pos(${rounded(x)},${rounded(y)})}${updated}` };
}

function fields(body: string, count: number): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 1; i < count; i++) {
    const comma = body.indexOf(',', start);
    if (comma < 0) return [];
    result.push(body.slice(start, comma));
    start = comma + 1;
  }
  result.push(body.slice(start));
  return result;
}

/** Move a composed libass layer when per-event anchors cannot preserve collisions. */
export function buildStyledAssDocument(content: string, style: SubtitleStyle) {
  const positionY = absoluteSubtitleY(style);
  if (positionY === undefined)
    return { content: styleAssDocument(content, style), translateY: 0 };
  const native = styleAssDocument(content, {
    ...style,
    positionY: undefined,
    positionReferenceY: undefined,
  });
  const resY = Number(/^\s*PlayResY\s*:\s*(\d+)/im.exec(native)?.[1]) || 288;
  let format = [...EVENT_FIELDS];
  let inEvents = false;
  const events: { text: string; marginV: number; effect: string }[] = [];
  for (const line of native.split('\n')) {
    if (/^\s*\[.*\]\s*$/.test(line))
      inEvents = line.trim().toLowerCase() === '[events]';
    if (!inEvents) continue;
    const header = /^\s*Format\s*:\s*(.*)$/i.exec(line);
    if (header)
      format = header[1]
        .toLowerCase()
        .split(',')
        .map((v) => v.trim());
    const event = /^\s*Dialogue\s*:(.*)$/i.exec(line);
    if (!event) continue;
    const values = fields(event[1], format.length);
    if (!values.length) continue;
    events.push({
      text: values[format.indexOf('text')],
      marginV: Number(values[format.indexOf('marginv')]) || style.marginV,
      effect: values[format.indexOf('effect')] || '',
    });
  }
  const referenceY =
    style.positionReferenceY ??
    events
      .map((event) => assEventPositionY(event.text, resY, 0, 1))
      .find((position) => position !== undefined) ??
    assMarginPositionY(events[0]?.text || '', style, resY, events[0]?.marginV);
  const translateY = (positionY - referenceY) / 100;
  const delta = translateY * resY;
  const needsLayer =
    Math.abs(delta) > 0.00001 &&
    events.some((event) => {
      if (
        assEventPositionY(event.text, resY, 0, 1) !== undefined ||
        /^Scroll (?:up|down);/.test(event.effect)
      )
        return false;
      const row = Math.floor(
        (assEventAlignment(event.text, style.alignment) - 1) / 3,
      );
      return row === 1 || event.marginV + (row === 0 ? -delta : delta) < 0;
    });
  return needsLayer
    ? { content: native, translateY }
    : { content: styleAssDocument(content, style), translateY: 0 };
}

/** One-input/one-output graph, also composable inside the audio mix graph. */
export function translatedAssFilter(assFilter: string, translateY = 0): string {
  if (!translateY) return assFilter;
  if (!Number.isFinite(translateY) || Math.abs(translateY) > 1)
    throw new Error('Invalid subtitle layer translation');
  return `split[ssbase][ssblank];[ssblank]format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa=0,${assFilter}:alpha=1[sslayer];[ssbase][sslayer]overlay=x=0:y=round(H*${translateY}):format=rgb:alpha=premultiplied`;
}

/** Preserve ASS event text, timing, drawings and effects while applying the editor's style. */
export function styleAssDocument(
  content: string,
  style: SubtitleStyle,
): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let resX = 384;
  let resY = 288;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) section = line.trim().toLowerCase();
    if (section !== '[script info]') continue;
    const match = /^\s*PlayRes([XY])\s*:\s*(\d+)\s*$/i.exec(line);
    if (!match || Number(match[2]) <= 0) continue;
    if (match[1].toLowerCase() === 'x') resX = Number(match[2]);
    else resY = Number(match[2]);
  }
  let referenceY = style.positionReferenceY;
  let implicitReferenceY: number | undefined;
  // Numeric positioning without a drag uses the first explicit native anchor.
  // A captured drag anchor may instead be at any point along an animated path.
  if (referenceY === undefined && absoluteSubtitleY(style) !== undefined) {
    let eventFormat = [...EVENT_FIELDS];
    section = '';
    for (const line of lines) {
      if (/^\s*\[.*\]\s*$/.test(line)) section = line.trim().toLowerCase();
      if (section !== '[events]') continue;
      const header = /^\s*Format\s*:\s*(.*)$/i.exec(line);
      if (header)
        eventFormat = header[1]
          .toLowerCase()
          .split(',')
          .map((field) => field.trim());
      const event = /^\s*Dialogue\s*:(.*)$/i.exec(line);
      if (!event || eventFormat.indexOf('text') !== eventFormat.length - 1)
        continue;
      const values = fields(event[1], eventFormat.length);
      if (!values.length) continue;
      implicitReferenceY ??= assMarginPositionY(
        values[eventFormat.indexOf('text')] || '',
        style,
        resY,
        Number(values[eventFormat.indexOf('marginv')]) || 0,
      );
      referenceY = assEventPositionY(
        values[eventFormat.indexOf('text')] || '',
        resY,
        0,
        1,
      );
      if (referenceY !== undefined) break;
    }
  }
  const row = Math.floor((style.alignment - 1) / 3);
  referenceY ??=
    implicitReferenceY ??
    ((row === 0 ? resY - style.marginV : row === 1 ? resY / 2 : style.marginV) /
      resY) *
      100;
  const styleValues = buildAssStyleLine(style)
    .slice('Style: '.length)
    .split(',');
  const replacements = new Map(
    STYLE_FIELDS.map((key, index) => [key, styleValues[index]]),
  );
  if (absoluteSubtitleY(style) !== undefined) {
    replacements.set('marginv', '0');
    styleValues[STYLE_FIELDS.indexOf('marginv')] = '0';
  }
  let format: string[] = [];
  const ssa = lines.some((line) => /^\s*\[v4 styles\]\s*$/i.test(line));
  section = '';
  return lines
    .flatMap((line, lineIndex) => {
      if (ssa && /^\s*ScriptType\s*:/i.test(line)) return 'ScriptType: v4.00+';
      if (/^\s*\[.*\]\s*$/.test(line)) {
        section = line.trim().toLowerCase();
        format =
          section === '[events]'
            ? [...EVENT_FIELDS]
            : section === '[v4 styles]'
              ? [...SSA_FIELDS]
              : section === '[v4+ styles]'
                ? [...STYLE_FIELDS]
                : [];
        if (section === '[events]' && ssa) format[0] = 'marked';
        const heading = section === '[v4 styles]' ? '[V4+ Styles]' : line;
        const nextSection = lines.findIndex(
          (candidate, index) =>
            index > lineIndex && /^\s*\[.*\]\s*$/.test(candidate),
        );
        const sectionLines = lines.slice(
          lineIndex + 1,
          nextSection < 0 ? undefined : nextSection,
        );
        if (
          format.length &&
          !sectionLines.some((candidate) => /^\s*Format\s*:/i.test(candidate))
        )
          return [
            heading,
            `Format: ${(section === '[v4 styles]' ? STYLE_FIELDS : format.map((key) => (key === 'marked' ? 'layer' : key))).join(',')}`,
          ];
        return heading;
      }
      if (!['[v4+ styles]', '[v4 styles]', '[events]'].includes(section))
        return line;
      const formatMatch = /^\s*Format\s*:\s*(.*)$/i.exec(line);
      if (formatMatch) {
        format = formatMatch[1]
          .toLowerCase()
          .split(',')
          .map((field) => field.trim());
        return section === '[v4 styles]'
          ? `Format: ${STYLE_FIELDS.join(',')}`
          : section === '[events]' && ssa
            ? `Format: ${format.map((key) => (key === 'marked' ? 'layer' : key)).join(',')}`
            : line;
      }
      if (!format.length) return line;
      const record = /^(\s*(?:Style|Dialogue)\s*:)(.*)$/i.exec(line);
      if (!record) return line;
      const values = fields(record[2], format.length);
      if (!values.length) return line;
      if (section !== '[events]') {
        if (section === '[v4 styles]') {
          const upgraded = [...styleValues];
          upgraded[0] = values[format.indexOf('name')].trim();
          const encoding = format.indexOf('encoding');
          if (encoding >= 0) upgraded[22] = values[encoding];
          return `Style: ${upgraded.join(',')}`;
        }
        return (
          record[1] +
          format
            .map((key, index) => {
              if (!CONTROLLED.has(key)) return values[index];
              return replacements.get(key) ?? values[index];
            })
            .join(',')
        );
      }
      const textIndex = format.indexOf('text');
      if (textIndex !== format.length - 1)
        throw new Error('Unsupported ASS event format');
      const original = values[textIndex];
      const eventStyle = { ...style };
      for (const field of ['marginL', 'marginR', 'marginV'] as const) {
        const margin = Number(values[format.indexOf(field.toLowerCase())]);
        if (Number.isFinite(margin) && margin !== 0) eventStyle[field] = margin;
      }
      const effectIndex = format.indexOf('effect');
      const moved = moveVertically(
        original,
        effectIndex >= 0 ? values[effectIndex] : '',
        eventStyle,
        resX,
        resY,
        referenceY,
      );
      values[textIndex] = appearanceText(moved.text, style);
      if (moved.effect !== undefined && effectIndex >= 0)
        values[effectIndex] = moved.effect;
      if (moved.marginV !== undefined && format.includes('marginv'))
        values[format.indexOf('marginv')] = String(moved.marginV);
      const layerIndex = format.indexOf(ssa ? 'marked' : 'layer');
      if (ssa && layerIndex >= 0) values[layerIndex] = '0';
      if (subtitleGlow(style) && layerIndex >= 0) {
        const layer = Number(values[layerIndex]) || 0;
        values[layerIndex] = String(layer * 2 + 1);
        const main = record[1] + values.join(',');
        if (/\\p[1-9]/.test(original)) return main;
        values[layerIndex] = String(layer * 2);
        values[textIndex] = assGlowText(values[textIndex], style);
        return [record[1] + values.join(','), main];
      }
      return record[1] + values.join(',');
    })
    .join('\n');
}
