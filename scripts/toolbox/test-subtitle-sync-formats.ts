import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { executeSubtitleSync } from '../../main/helpers/toolbox/subtitleSync';

const vtt = [
  '\uFEFFWEBVTT subtitles',
  'Kind: captions',
  '',
  'NOTE preserve this block',
  '00:01.000 --> 00:03.000',
  '',
  'STYLE',
  '::cue { color: lime }',
  '',
  'REGION',
  'id:top',
  '',
  'intro-cue',
  '00:01.000   -->  00:03.000 position:20% align:start region:top',
  '<v Narrator>Hello world</v>',
  '',
  '00:04.000 --> 00:06.000',
  'Second cue',
  '',
].join('\r\n');

const ass = [
  '[Script Info]',
  'Title: Preserved',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Fancy,Arial,22',
  '',
  '[Events]',
  'Format: Layer, Style, Start, End, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Comment: 0,Fancy,0:00:01.00,0:00:02.00,,0,0,0,,unmodified comment',
  'Dialogue: 0,Fancy, 0:00:01.00 , 0:00:03.00 ,Actor,10,20,30,,{\\pos(10,20)}Hello, world\\NSecond line',
  '',
].join('\n');

async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-sync-format-'));
  try {
    const cases = [
      {
        extension: 'vtt',
        input: vtt,
        shifted: vtt
          .replace('00:01.000   -->  00:03.000', '00:02.000   -->  00:04.000')
          .replace('00:04.000 --> 00:06.000', '00:05.000 --> 00:07.000'),
        count: 2,
      },
      {
        extension: 'ass',
        input: ass,
        shifted: ass.replace(
          ' 0:00:01.00 , 0:00:03.00 ',
          ' 0:00:02.00 , 0:00:04.00 ',
        ),
        count: 1,
      },
      {
        extension: 'ssa',
        input: ass
          .replace('v4.00+', 'v4.00')
          .replace('[V4+ Styles]', '[V4 Styles]'),
        shifted: ass
          .replace('v4.00+', 'v4.00')
          .replace('[V4+ Styles]', '[V4 Styles]')
          .replace(' 0:00:01.00 , 0:00:03.00 ', ' 0:00:02.00 , 0:00:04.00 '),
        count: 1,
      },
    ];

    for (const { extension, input, shifted, count } of cases) {
      const filePath = path.join(dir, `input.${extension}`);
      await fs.writeFile(filePath, input);
      for (const [offsetMs, expected] of [
        [0, input],
        [1000, shifted],
      ] as const) {
        const result = await executeSubtitleSync({
          filePath,
          outputPath: path.join(dir, `output-${offsetMs}.${extension}`),
          mode: 'offset',
          offsetMs,
        });
        assert.ok(result.success, result.error);
        assert.equal(result.cuesCount, count);
        assert.deepStrictEqual(
          await fs.readFile(result.outputPath),
          Buffer.from(expected),
          `${extension} at offset ${offsetMs} should only change cue times`,
        );
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
