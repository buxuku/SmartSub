import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {
  buildAssDocument,
  cssColorToAss,
} from '../main/helpers/assStyleBuilder';
import { subtitleStyleToCSS } from '../renderer/components/subtitleMerge/utils/styleUtils';
import { styleAssDocument } from '../main/helpers/assCanvas';
import { resolveAssFonts } from '../main/helpers/assFonts';
import {
  resolveBurnFontName,
  fontTextRuns,
  listSubtitleFonts,
} from '../main/helpers/fontResolver';
import { subtitleTextRuns } from '../types/subtitleAppearance';
import { mapAssOverrideBlocks } from '../types/assOverrides';
import { assEventPositionY } from '../types/subtitleCanvas';
import { invalidSubtitleStyleFields } from '../types/subtitleStyleValidation';
import { subtitleColorSwatch } from '../types/subtitleColor';
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
} from '../renderer/components/subtitleMerge/constants';

async function main() {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-appearance-unit-'),
  );
  const style = {
    ...DEFAULT_STYLE,
    fontName: resolveBurnFontName('Arial', false),
  };
  const text = 'SmartSub Plus\n字幕示例';
  for (const preset of STYLE_PRESETS)
    assert.deepEqual(invalidSubtitleStyleFields(preset.style), []);
  assert.deepEqual(
    invalidSubtitleStyleFields({
      ...style,
      primaryColor: '#F',
      fontSize: -1,
      positionY: 101,
      marginV: -1,
    }),
    ['fontSize', 'primaryColor', 'marginV', 'positionY'],
  );
  for (const primaryColor of [
    '#GGGGGG',
    'red',
    'rgb(256,0,0)',
    'rgba(0,0,0,2)',
    '#123456extra',
  ])
    assert.ok(
      invalidSubtitleStyleFields({ ...style, primaryColor }).includes(
        'primaryColor',
      ),
    );
  for (const primaryColor of [
    '#abcdef',
    'rgb(255, 0, 20)',
    'rgba(255,0,20,0.5)',
    'rgb( 255 , 0, 20 )',
    'RGBA( 255, 0, 20, 0.5 )',
  ])
    assert.deepEqual(
      invalidSubtitleStyleFields({ ...style, primaryColor }),
      [],
    );
  assert.throws(() => cssColorToAss('#F'), /Invalid subtitle color/);
  assert.equal(subtitleColorSwatch('rgba( 255, 0, 20, 0.5 )'), '#ff0014');
  assert.equal(subtitleColorSwatch('#F'), '#000000');
  assert.equal(
    subtitleStyleToCSS({
      ...style,
      borderStyle: 3,
      backColor: 'rgba( 255, 0, 20, 0.5 )',
      backOpacity: 30,
    }).backgroundColor,
    'rgba(255, 0, 20, 0.15)',
  );
  assert.deepEqual(
    subtitleTextRuns('AA A', {
      ...style,
      highlightTerms: ['A', 'AA'],
      highlightColor: '#FF0000',
    }),
    [
      { text: 'AA', color: '#FF0000' },
      { text: ' ', color: '#FFFFFF' },
      { text: 'A', color: '#FF0000' },
    ],
  );
  assert.equal(
    subtitleTextRuns(text, style)
      .map((run) => run.text)
      .join(''),
    text,
  );
  const base = buildAssDocument([{ startMs: 0, endMs: 1000, text }], style);
  const nested =
    '{comment\\fnArial\\t(0,800,\\clip(0,0,384,288)\\fscx130)\\rDefault}TEST';
  const topLevel: string[] = [];
  assert.equal(
    mapAssOverrideBlocks(nested, (tag) => {
      topLevel.push(tag);
      return tag;
    }),
    nested,
  );
  assert.deepEqual(topLevel, [
    '\\fnArial',
    '\\t(0,800,\\clip(0,0,384,288)\\fscx130)',
    '\\rDefault',
  ]);
  assert.equal(
    assEventPositionY(
      '{\\t(0,500,\\pos(10,20))\\pos(50,144)}TEST',
      288,
      0,
      1000,
    ),
    50,
  );
  const invalidAnimatedState =
    '{\\t(0,800,\\fnNeverInstalled\\p1\\rIgnored)}Wiii';
  const animatedState = resolveAssFonts(
    base.replace('SmartSub Plus\\N字幕示例', invalidAnimatedState),
    style.fontName,
  );
  assert.ok(
    animatedState.content.includes(invalidAnimatedState),
    'non-animatable tags inside t must not change font/drawing state or destroy closing parentheses',
  );
  assert.deepEqual(animatedState.fontNames, [style.fontName]);
  const highlightedAnimation = styleAssDocument(
    base.replace('SmartSub Plus\\N字幕示例', invalidAnimatedState),
    { ...style, highlightTerms: ['Wiii'] },
  );
  assert.match(highlightedAnimation, /\\1c&H00FFFF&\\1a&H00&\}Wiii/);
  const highlightStyle = {
    ...style,
    highlightTerms: ['SmartSub'],
    highlightColor: 'rgba( 255, 0, 20, 0.5 )',
  };
  const crossTagText = 'Smart{\\b1}Sub{\\rDefault} plain';
  const crossTag = styleAssDocument(
    base.replace('SmartSub Plus\\N字幕示例', crossTagText),
    highlightStyle,
  );
  assert.ok(
    crossTag.includes(
      '{\\1c&H1400FF&\\1a&H80&}Smart{\\b1}{\\1c&H1400FF&\\1a&H80&}Sub{\\rDefault}{\\1c&HFFFFFF&\\1a&H00&} plain',
    ),
  );
  const crossDrawing = styleAssDocument(
    base.replace(
      'SmartSub Plus\\N字幕示例',
      'Smart{\\p1}m 0 0 l 20 20{\\p0}Sub',
    ),
    highlightStyle,
  );
  assert.doesNotMatch(crossDrawing, /\\1c&H1400FF/);
  assert.ok(crossDrawing.includes('{\\p1}m 0 0 l 20 20{\\p0}'));
  const crossLine = styleAssDocument(
    base.replace('SmartSub Plus\\N字幕示例', 'Smart\\NSub'),
    highlightStyle,
  );
  assert.doesNotMatch(crossLine, /\\1c&H1400FF/);
  const spaceHighlight = styleAssDocument(
    base.replace('SmartSub Plus\\N字幕示例', 'Smart\\hSub'),
    { ...highlightStyle, highlightTerms: ['Smart\u00a0Sub'] },
  );
  assert.ok(spaceHighlight.includes('{\\1c&H1400FF&\\1a&H80&}\\h'));
  const resetGlow = styleAssDocument(
    base.replace(
      'SmartSub Plus\\N字幕示例',
      '{\\rDefault\\t(0,800,\\fscx130)}TEST',
    ),
    { ...style, glow: 3 },
  );
  assert.match(
    resetGlow,
    /\{\\rDefault\\1a&HFF&[^}]*\\t\(0,800,\\fscx130\)\}TEST/,
  );
  assert.doesNotMatch(resetGlow, /\{\}|\{[^}]*\{/);
  const fallback = resolveAssFonts(base, style.fontName);
  assert.match(fallback.content, /SmartSub Plus/);
  assert.ok(
    fallback.fontNames.length >= 2,
    'Latin primary is not replaced by a proportional CJK font',
  );
  assert.equal(
    fontTextRuns('Wiii', style.fontName)[0].fontName,
    style.fontName,
  );
  assert.throws(() => fontTextRuns('\u{10FFFF}', style.fontName), /U\+10FFFF/);
  if (process.platform === 'darwin') {
    assert.equal(
      resolveBurnFontName('Hiragino Sans GB', true),
      'Hiragino Sans GB W3',
    );
    assert.equal(
      (await listSubtitleFonts()).find((font) => font.name === 'Songti SC')
        ?.available,
      true,
    );
  }
  const move = base.replace(
    'SmartSub Plus\\N字幕示例',
    '{\\move(20,240,300,220,100,900)\\t(0,500,\\fscx120)\\fad(20,30)}SmartSub Plus\\N字幕示例',
  );
  const moved = styleAssDocument(move, { ...style, positionY: 50 });
  assert.match(moved, /\\move\(20,144,300,124,100,900\)/);
  assert.match(moved, /\\t\(0,500,\\fscx120\)\\fad\(20,30\)/);
  const drawing = base.replace(
    'SmartSub Plus\\N字幕示例',
    '{\\p1}m 0 0 l 20 0 20 20 0 20{\\p0}SmartSub Plus',
  );
  const drawingFont = resolveAssFonts(
    styleAssDocument(drawing, { ...style, highlightTerms: ['20', 'SmartSub'] }),
    style.fontName,
  );
  assert.match(drawingFont.content, /\{\\p1\}m 0 0 l 20 0 20 20 0 20\{\\p0\}/);
  const noFormat = base.replace(/^Format:.*\n/gm, '');
  assert.match(
    resolveAssFonts(styleAssDocument(noFormat, style), style.fontName).content,
    /Dialogue:/,
  );
  const ssa =
    '[Script Info]\nScriptType: v4.00\nPlayResX: 384\nPlayResY: 288\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Legacy,Arial,24,16777215,255,0,0,0,0,1,2,0,2,20,20,20,128,1\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.00,0:00:01.00,Legacy,,0,0,0,,TEST\n';
  const converted = styleAssDocument(ssa, {
    ...style,
    primaryColor: '#FFFF00',
    backOpacity: 30,
  });
  assert.match(converted, /ScriptType: v4.00\+/);
  assert.match(converted, /Style: Legacy,.*&H0000FFFF.*&HB3000000/);
  assert.match(converted, /Dialogue:0,/);
  const cases: [string, string, 'yellow' | 'pink' | 'white'][] = [
    ['ssa', converted, 'yellow'],
    ['no-format', styleAssDocument(noFormat, style), 'white'],
  ];
  for (const preset of STYLE_PRESETS.filter((preset) =>
    ['bilibili_knowledge', 'netflix_bilingual', 'variety_glow'].includes(
      preset.id,
    ),
  )) {
    const presetStyle = {
      ...preset.style,
      fontName: resolveBurnFontName(preset.style.fontName, true),
    };
    for (const native of [false, true]) {
      const content = native
        ? styleAssDocument(base, presetStyle)
        : buildAssDocument([{ startMs: 0, endMs: 1000, text }], presetStyle);
      cases.push([
        `${preset.id}-${native ? 'ass' : 'srt'}`,
        content,
        preset.id === 'variety_glow' ? 'pink' : 'yellow',
      ]);
      if (preset.id === 'variety_glow')
        assert.equal(
          content.split('\n').filter((line) => line.startsWith('Dialogue:'))
            .length,
          2,
        );
    }
  }
  for (const [name, content, color] of cases) {
    const file = path.join(output, `${name}.ass`);
    const primaryFont = /^Style:\s*[^,]*,([^,]*)/m.exec(content)![1];
    await fs.writeFile(file, resolveAssFonts(content, primaryFont).content);
    const pixels = execFileSync(ffmpeg!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=384x288:d=1',
      '-vf',
      `ass='${file}'`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (
        color === 'yellow'
          ? r > 160 && g > 160 && b < 100
          : color === 'pink'
            ? r > 70 && r > g * 1.35 && b > g * 1.2
            : r > 180 && g > 180 && b > 180
      )
        colored++;
    }
    assert.ok(colored > 40, `${name} must render ${color}`);
  }
  const animationText =
    '{\\rDefault\\pos(192,144)\\t(0,800,\\fscx170)\\t(0,800,\\clip(0,0,384,288))}TEST RESET';
  const animationSource = base.replace(
    'SmartSub Plus\\N字幕示例',
    animationText,
  );
  const animationFile = path.join(output, 'nested-animation.ass');
  const referenceFile = path.join(output, 'nested-reference.ass');
  await fs.writeFile(
    animationFile,
    resolveAssFonts(styleAssDocument(animationSource, style), style.fontName)
      .content,
  );
  await fs.writeFile(referenceFile, animationSource);
  const renderAt = (file: string, time: number) =>
    execFileSync(ffmpeg!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=384x288:r=25:d=1',
      '-vf',
      `ass='${file}'`,
      '-ss',
      String(time),
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
  const pixelPairs: [string, string, string][] = [
    [
      'cross-tag-highlight',
      crossTag,
      base.replace(
        'SmartSub Plus\\N字幕示例',
        '{\\1c&H1400FF&\\1a&H80&}Smart{\\b1}Sub{\\rDefault} plain',
      ),
    ],
    [
      'rgb-whitespace',
      buildAssDocument([{ startMs: 0, endMs: 1000, text: 'COLOR' }], {
        ...style,
        primaryColor: 'rgb( 255 , 0 , 20 )',
      }),
      buildAssDocument([{ startMs: 0, endMs: 1000, text: 'COLOR' }], {
        ...style,
        primaryColor: '#FF0014',
      }),
    ],
  ];
  const translucent = {
    ...style,
    primaryColor: 'rgba(255,255,255,0.5)',
    glow: 3,
  };
  pixelPairs.push([
    'glow-highlight-alpha',
    buildAssDocument([{ startMs: 0, endMs: 1000, text: 'GLOW' }], {
      ...translucent,
      highlightTerms: ['GLOW'],
      highlightColor: translucent.primaryColor,
    }),
    buildAssDocument([{ startMs: 0, endMs: 1000, text: 'GLOW' }], translucent),
  ]);
  for (const [name, actual, expected] of pixelPairs) {
    const actualFile = path.join(output, `${name}-actual.ass`);
    const expectedFile = path.join(output, `${name}-expected.ass`);
    await fs.writeFile(actualFile, actual);
    await fs.writeFile(expectedFile, expected);
    assert.deepEqual(
      renderAt(actualFile, 0),
      renderAt(expectedFile, 0),
      `${name} must preserve exact libass pixels`,
    );
  }
  const opacityMaxima: number[] = [];
  for (const opacity of [0, 0.5, 1]) {
    const file = path.join(output, `opacity-${opacity}.ass`);
    await fs.writeFile(
      file,
      buildAssDocument([{ startMs: 0, endMs: 1000, text: 'OPACITY' }], {
        ...style,
        primaryColor: `rgba(255,255,255,${opacity})`,
        outline: 0,
        shadow: 0,
      }),
    );
    const pixels = renderAt(file, 0);
    opacityMaxima.push(pixels.reduce((max, value) => Math.max(max, value), 0));
  }
  assert.equal(opacityMaxima[0], 0, 'transparent fill does not render');
  assert.ok(
    opacityMaxima[1] >= 120 && opacityMaxima[1] <= 132,
    'half-opacity fill stays half bright on black',
  );
  assert.ok(opacityMaxima[2] >= 250, 'opaque fill renders bright white');
  const frames = [0, 0.4, 0.8].map((time) => {
    const actual = renderAt(animationFile, time);
    assert.deepEqual(
      actual,
      renderAt(referenceFile, time),
      `nested clip/scale and named reset must retain libass pixels at ${time}s`,
    );
    return actual;
  });
  assert.notDeepEqual(
    frames[0],
    frames[2],
    'the reference animation must actually change rendered pixels',
  );
  console.log(
    JSON.stringify({
      output,
      cases: cases.length,
      animatedFrames: frames.length,
      colorPixelPairs: pixelPairs.length,
      opacityMaxima,
      result: 'passed',
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
