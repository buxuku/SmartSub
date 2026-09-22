import assert from 'node:assert/strict';
import {
  parseSubtitleCues,
  parseSubtitleEntries,
  serializeSubtitleCues,
  type SubtitleFormat,
} from '../main/helpers/subtitleFormats';
import {
  assertValidProofreadData,
  normalizeProofreadData,
} from '../types/proofreadData';

const cue = { startMs: 1000, endMs: 3000, text: 'Original\nsubtitle' };
const strict = { strict: true };
let checks = 0;
for (const format of ['srt', 'vtt', 'ass', 'lrc'] as SubtitleFormat[]) {
  const content = serializeSubtitleCues([cue], format);
  assert.equal(parseSubtitleEntries(content, format, strict).length, 1);
  assert.deepEqual(parseSubtitleCues('', format, strict), []);
  assert.deepEqual(
    parseSubtitleCues(serializeSubtitleCues([], format), format, strict),
    [],
  );
  assert.throws(() =>
    parseSubtitleCues(`${content}\n\nBroken subtitle block`, format, strict),
  );
  assert.equal(
    parseSubtitleCues(`${content}\n\nBroken subtitle block`, format).length,
    1,
  );
  checks += 5;
}
const srt = serializeSubtitleCues([cue], 'srt');
for (const content of [
  srt.replace('00:00:01,000', 'invalid'),
  srt.replace('00:00:01,000', '00:70:01,000'),
  srt.replace('00:00:01,000', '00:00:61,000'),
  srt.replace('00:00:01,000', '00:00:01,000garbage'),
  srt.replace('00:00:03,000', '00:00:00,000'),
  srt.replace('00:00:03,000', '00:00:01,000'),
  `${srt.trimEnd()}\n${srt}`,
  '1\nBroken timing\nText',
  `Unrecognized preamble\n${srt}`,
]) {
  assert.throws(() => parseSubtitleCues(content, 'srt', strict));
  checks++;
}
assert.equal(
  parseSubtitleCues(
    `\ufeff${srt}\n \n${srt}`.replace(/\n/g, '\r\n'),
    'srt',
    strict,
  ).length,
  2,
);
assert.equal(
  parseSubtitleCues(
    'WEBVTT\n\nNOTE Test\nignore\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:one\n\ncue id\n00:01.000 --> 00:03.000 align:start\nText',
    'vtt',
    strict,
  ).length,
  1,
);
assert.throws(() =>
  parseSubtitleCues('WEBVTT\n00:01.000 --> 00:03.000\nText', 'vtt', strict),
);
assert.throws(() =>
  parseSubtitleCues(
    'WEBVTT\n00:01.000 --> 00:03.000\nLost first cue\n\n00:04.000 --> 00:05.000\nSecond cue',
    'vtt',
    strict,
  ),
);
for (const format of ['srt', 'vtt', 'ass'] as SubtitleFormat[]) {
  const emptyText = serializeSubtitleCues([{ ...cue, text: '' }], format);
  assert.deepEqual(parseSubtitleCues(emptyText, format, strict), [
    { ...cue, text: '' },
  ]);
  checks++;
}
for (const content of [
  '[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Text',
  '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00',
  '[Events]\nFormat: Start, End, Text\nDialogue: wrong,0:00:03.00,Text',
  '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:03.00,Text\nDialog: broken',
]) {
  assert.throws(() => parseSubtitleCues(content, 'ass', strict));
  checks++;
}
assert.equal(
  parseSubtitleCues(
    '[ar:Artist]\n[offset:100]\n[00:01.00][00:03.00]Text\n[00:06.00]',
    'lrc',
    strict,
  ).length,
  2,
);
for (const content of [
  '[00:61.00]Text',
  '[00:01.00][00:bad]Text',
  'Lost text',
]) {
  assert.throws(() => parseSubtitleCues(content, 'lrc', strict));
  checks++;
}
const data = {
  version: 2,
  cues: [
    {
      id: '1',
      startMs: 1000,
      endMs: 3000,
      source: 'Source',
      target: 'Target',
      speakerIds: [1],
    },
  ],
  speakers: [{ id: 1, displayName: 'Speaker', color: '#2563eb' }],
};
assert.doesNotThrow(() => assertValidProofreadData(data));
assert.doesNotThrow(() => assertValidProofreadData({ version: 1, cues: [] }));
assert.doesNotThrow(() => assertValidProofreadData({ version: 2, cues: [] }));
assert.equal(normalizeProofreadData(data).cues[0].source, 'Source');
for (const change of [
  { startMs: '1000' },
  { startMs: -1 },
  { endMs: 500 },
  { endMs: null },
  { source: { text: 'Lost text' } },
  { target: ['Lost target'] },
  { speakerIds: [0] },
  { primarySpeakerId: '1' },
]) {
  assert.throws(() =>
    assertValidProofreadData({
      ...data,
      cues: [{ ...data.cues[0], ...change }],
    }),
  );
  checks++;
}
for (const speakers of [
  null,
  {},
  [data.speakers[0], data.speakers[0]],
  [{ id: 1 }],
]) {
  assert.throws(() => assertValidProofreadData({ ...data, speakers }));
  checks++;
}
console.log(`Proofread strict parsing: ${checks + 9} checks passed`);
