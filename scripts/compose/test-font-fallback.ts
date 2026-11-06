import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  embeddedFontContext,
  fontTextRuns,
  localizedFamilyNames,
  listSubtitleFonts,
  isFontAvailable,
  newFontFallbackReport,
  prepareSubtitleFonts,
  recommendFontsForText,
  resolveFontFilePath,
  summarizeFontFallbackReport,
} from '../../main/helpers/fontResolver';
import { commonFontRank } from '../../main/helpers/commonFonts';
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

  // 7. Common-font ranking matches English and localized names, case-insensitively.
  assert.equal(commonFontRank(['pingfang sc']), 0);
  assert.equal(commonFontRank(['苹方-简']), 0);
  assert.ok(commonFontRank(['Arial'])! > commonFontRank(['Microsoft YaHei'])!);
  assert.equal(commonFontRank(['Hiragino Sans W3']), undefined);
  assert.equal(commonFontRank([]), undefined);

  // 8. Localized names exclude the English family and prefer Chinese for display.
  const face = (fontFamily: Record<string, string>, preferred = {}) =>
    ({
      familyName: 'Heiti TC',
      name: { records: { fontFamily, preferredFamily: preferred } },
    }) as any;
  assert.deepEqual(
    localizedFamilyNames(
      face({
        en: 'Heiti TC',
        'zh-TW': '黑體-繁',
        ja: '黒体-繁',
        zh: '黑体-繁',
      }),
    ),
    {
      displayName: '黑体-繁',
      localizedNames: ['黑體-繁', '黒体-繁', '黑体-繁'],
    },
  );
  assert.deepEqual(localizedFamilyNames(face({ en: 'Heiti TC' })), {
    localizedNames: [],
  });

  // 9. The listing carries rank and localized names for the picker.
  const listed = await listSubtitleFonts(context);
  const codicon = listed.find((font) => font.name === 'codicon')!;
  assert.equal(codicon.rank, undefined);
  assert.ok(Array.isArray(codicon.localizedNames));

  // 10. Invisible characters stay on the requested font and never create a fallback notice.
  const quiet = newFontFallbackReport();
  const quietRuns = fontTextRuns('\uea60\u200b', 'codicon', context, quiet);
  assert.deepEqual(quietRuns, [{ fontName: 'codicon', text: '\uea60\u200b' }]);
  assert.deepEqual(summarizeFontFallbackReport(quiet).fallbacks, []);

  // 11. Recommendations only name fonts that need no fallback for the whole text.
  const embedded = await recommendFontsForText('\uea60', context);
  assert.deepEqual(
    embedded.fonts.map((font) => font.name),
    ['codicon'],
    'a document font covering the text is recommended',
  );
  assert.equal(embedded.complete, true);
  assert.deepEqual(
    (await recommendFontsForText('\uea60', context, { exclude: 'codicon' }))
      .fonts,
    [],
    'the current font is never recommended',
  );
  assert.deepEqual((await recommendFontsForText('\u{10FFFF}')).fonts, []);
  const hangulText = '지금 채팅은 하나';
  const hangul = await recommendFontsForText(hangulText, [], { limit: 3 });
  for (const font of hangul.fonts) {
    const check = newFontFallbackReport();
    fontTextRuns(hangulText, font.name, [], check);
    assert.deepEqual(
      summarizeFontFallbackReport(check),
      { fallbacks: [], missingGlyphs: [] },
      `${font.name} must render the whole text without fallback`,
    );
  }
  if (hangulFont) assert.ok(hangul.fonts.length > 0, 'a Hangul font is found');
  assert.ok(hangul.fonts.length <= 3);
  const rushed = await recommendFontsForText(hangulText, [], { budgetMs: 0 });
  assert.equal(rushed.complete, false, 'an exhausted budget is reported');

  console.log('font fallback checks passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
