import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {
  readAssEmbeddedFonts,
  normalizeAssFontSections,
} from '../../main/helpers/assEmbeddedFonts';
import {
  embeddedFontContext,
  resolveBurnFontName,
  isFontAvailable,
  fontTextRuns,
  loadFontData,
  listSubtitleFonts,
  prepareSubtitleFonts,
} from '../../main/helpers/fontResolver';
import { resolveAssFonts } from '../../main/helpers/assFonts';
import { buildAssDocument } from '../../main/helpers/assStyleBuilder';
import { DEFAULT_STYLE } from '../../renderer/components/subtitleMerge/constants';
import { embeddedFontFixture, fontSection } from './embedded-font-fixture.mjs';

async function main() {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-embedded-fonts-unit-'),
  );
  const data = embeddedFontFixture();
  const embedded = fontSection(data, '../../not-a-file.ttf');
  assert.deepEqual(readAssEmbeddedFonts(embedded)[0].data, data);
  for (const section of [
    '[Aegisub Extradata]',
    '[Custom Extension]',
    '[Vendor.Data v2]',
    '[CUSTOM]',
  ]) {
    assert.deepEqual(
      readAssEmbeddedFonts(embedded + section + '\nmetadata: ignored\n')[0]
        .data,
      data,
    );
  }
  assert.deepEqual(
    readAssEmbeddedFonts('[Fonts]\nfontname: encoded.ttf\n[AB]\n')[0].data,
    readAssEmbeddedFonts('[Fonts]\nfontname: encoded.ttf\n[A\nB]\n')[0].data,
  );
  for (let length = 1; length <= 8; length++) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => i * 31));
    assert.deepEqual(readAssEmbeddedFonts(fontSection(bytes))[0].data, bytes);
  }
  assert.deepEqual(readAssEmbeddedFonts('[Events]\nfontname: ignored'), []);
  assert.throws(
    () => readAssEmbeddedFonts('[Fonts]\nfontname: bad\n!'),
    /encoding/,
  );
  assert.throws(
    () => readAssEmbeddedFonts('[Fonts]\nfontname: bad\nzz'),
    /encoding/,
  );
  assert.throws(
    () => embeddedFontContext(fontSection(Buffer.from([1, 2, 3]))),
    /Invalid ASS embedded font/,
  );
  assert.throws(
    () => readAssEmbeddedFonts(fontSection(Buffer.from([1, 2, 3])).repeat(65)),
    /document limit/,
  );
  const context = embeddedFontContext(embedded);
  await prepareSubtitleFonts();
  assert.equal(
    isFontAvailable('codicon'),
    false,
    'fixture must not be an installed system font',
  );
  if (process.platform === 'darwin') {
    assert.equal(isFontAvailable('Menlo'), true);
    assert.equal(resolveBurnFontName('Menlo-Regular', false), 'Menlo');
    assert.equal(
      (await listSubtitleFonts()).find((font) => font.name === 'Menlo')
        ?.available,
      true,
    );
  }
  assert.equal(isFontAvailable('codicon', context), true);
  assert.equal(resolveBurnFontName('codicon', false, context), 'codicon');
  const text = '\uea60\uea61\uea62';
  assert.deepEqual(fontTextRuns(text, 'codicon', context), [
    { fontName: 'codicon', text },
  ]);
  assert.notEqual(
    fontTextRuns(' TEXT', 'codicon', context)[0].fontName,
    'codicon',
    'missing space must share the explicit fallback, not an engine-dependent advance',
  );
  assert.deepEqual(loadFontData('codicon', context)?.data, data);
  assert.ok(
    (await listSubtitleFonts(context)).find((font) => font.name === 'codicon')
      ?.embeddedId,
  );
  assert.equal(
    isFontAvailable('codicon'),
    false,
    'document font must not escape into another document',
  );
  const style = {
    ...DEFAULT_STYLE,
    fontName: 'Arial',
    fontSize: 40,
    outline: 0,
    shadow: 0,
    alignment: 5 as const,
  };
  const original =
    buildAssDocument(
      [{ startMs: 0, endMs: 1000, text: 'TEXT' }],
      style,
    ).replace('TEXT', `{\\fncodicon}${text}{\\r}TEXT`) + embedded;
  const resolved = resolveAssFonts(original, 'Arial', context);
  assert.match(resolved.content, /\\fncodicon/);
  assert.ok(resolved.fontNames.includes('codicon'));
  assert.deepEqual(readAssEmbeddedFonts(resolved.content)[0].data, data);
  const beforeFile = path.join(output, 'original.ass');
  const afterFile = path.join(output, 'resolved.ass');
  await fs.writeFile(beforeFile, original);
  await fs.writeFile(afterFile, resolved.content);
  const render = (file: string) =>
    execFileSync(ffmpeg!, [
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
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
  assert.deepEqual(
    render(beforeFile),
    render(afterFile),
    'resolving inline fonts must preserve actual embedded glyphs',
  );
  const extended = normalizeAssFontSections(
    resolved.content + '\n[Aegisub Extradata]\nData: 0,custom,metadata\n',
  );
  assert.match(extended, /\[Aegisub Extradata\]\nData: 0,custom,metadata/);
  assert.deepEqual(readAssEmbeddedFonts(extended)[0].data, data);
  assert.equal(normalizeAssFontSections(extended), extended);
  await fs.writeFile(afterFile, extended);
  assert.deepEqual(
    render(beforeFile),
    render(afterFile),
    'unknown extension after fonts must not corrupt libass attachment',
  );
  const missing = original.replace(embedded, '');
  await fs.writeFile(afterFile, missing);
  assert.notDeepEqual(
    render(beforeFile),
    render(afterFile),
    'font attachment must change visible output',
  );
  console.log(
    JSON.stringify({
      output,
      checks:
        'binary decode/tails, malformed/limit handling, isolated font context, inline private-use glyphs and exact libass pixel equivalence',
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
