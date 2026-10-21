import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  embeddedFontContext,
  fontTextRuns,
  isFontAvailable,
  newFontFallbackReport,
  prepareSubtitleFonts,
  resolveFontFilePath,
  summarizeFontFallbackReport,
} from '../../main/helpers/fontResolver';
import { embeddedFontFixture, fontSection } from './embedded-font-fixture.mjs';

async function main() {
  await prepareSubtitleFonts();
  const context = embeddedFontContext(
    fontSection(embeddedFontFixture(), 'codicon.ttf'),
  );

  // 1. A character that no installed font covers must degrade, not throw.
  const missingReport = newFontFallbackReport();
  const runs = fontTextRuns(
    '\uea60\u{10FFFF}',
    'codicon',
    context,
    missingReport,
  );
  assert.equal(runs.map((run) => run.text).join(''), '\uea60\u{10FFFF}');
  assert.equal(runs[0].fontName, 'codicon');
  assert.deepEqual(summarizeFontFallbackReport(missingReport).missingGlyphs, [
    '\u{10FFFF}',
  ]);
  assert.deepEqual(summarizeFontFallbackReport(missingReport).fallbacks, []);

  // 2. Invisible format characters are not reported as missing glyphs.
  const invisible = newFontFallbackReport();
  fontTextRuns('\uea60\u200b\ufeff', 'codicon', context, invisible);
  assert.deepEqual(summarizeFontFallbackReport(invisible).missingGlyphs, []);

  // 3. Fully covered text produces an empty report.
  const clean = newFontFallbackReport();
  assert.deepEqual(fontTextRuns('\uea60', 'codicon', context, clean), [
    { fontName: 'codicon', text: '\uea60' },
  ]);
  assert.deepEqual(summarizeFontFallbackReport(clean), {
    fallbacks: [],
    missingGlyphs: [],
  });

  // 4. Report is optional and the legacy call shape still works.
  assert.doesNotThrow(() => fontTextRuns('\u{10FFFF}', 'codicon', context));

  // 5. An embedded font is used as a fallback for a missing system glyph.
  const primary = ['Arial', 'Helvetica', 'DejaVu Sans'].find((name) =>
    isFontAvailable(name),
  );
  if (primary) {
    const report = newFontFallbackReport();
    const fallbackRuns = fontTextRuns('A\uea60', primary, context, report);
    assert.deepEqual(
      fallbackRuns.map((run) => run.text),
      ['A', '\uea60'],
    );
    assert.equal(fallbackRuns[1].fontName, 'codicon');
    const summary = summarizeFontFallbackReport(report);
    assert.equal(summary.fallbacks[0].to, 'codicon');
    assert.equal(summary.fallbacks[0].sample, '\uea60');
    assert.deepEqual(summary.missingGlyphs, []);
  }

  // 6. Korean falls back to a system Hangul font on platforms that ship one.
  const hangulFonts: Record<string, string[]> = {
    darwin: ['Apple SD Gothic Neo', 'AppleGothic', 'Arial Unicode MS'],
    win32: ['Malgun Gothic'],
    linux: ['Noto Sans CJK KR', 'Noto Sans CJK SC', 'Noto Sans SC'],
  };
  const hangulFont = (hangulFonts[process.platform] || []).find(
    (name) =>
      resolveFontFilePath(name) && fs.existsSync(resolveFontFilePath(name)!),
  );
  const latin = ['Helvetica', 'Arial', 'DejaVu Sans'].find((name) =>
    isFontAvailable(name),
  );
  if (hangulFont && latin) {
    const report = newFontFallbackReport();
    const korean = fontTextRuns('지금 채팅은 하나', latin, [], report);
    assert.ok(korean.some((run) => run.fontName !== latin));
    const summary = summarizeFontFallbackReport(report);
    assert.deepEqual(summary.missingGlyphs, []);
    assert.ok(summary.fallbacks.length >= 1);
    assert.equal(summary.fallbacks[0].from, latin);
  } else {
    console.log('skip: no Hangul system font on this platform');
  }

  console.log('font fallback checks passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
