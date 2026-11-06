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
  repairNonPositiveCueDurations,
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

// Cue timing repair: the strict reader above rejects `endMs <= startMs`, so a
// sidecar must never carry such a cue. Zero-length and inverted cues get a
// visible duration instead of being dropped or blocking the whole file.
let repairChecks = 0;
function expectEqual<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  repairChecks++;
}
function expectValid(cues: unknown[], message: string): void {
  assert.doesNotThrow(
    () => assertValidProofreadData({ version: 2, speakers: [], cues }),
    message,
  );
  repairChecks++;
}
function timed(id: string, startMs: number, endMs: number) {
  return { id, startMs, endMs, source: `source ${id}`, target: `target ${id}` };
}

const wellFormed = [timed('1', 0, 1000), timed('2', 1000, 2000)];
const wellFormedResult = repairNonPositiveCueDurations(wellFormed);
expectEqual(wellFormedResult.repairs, [], 'valid cues need no repair');
expectEqual(wellFormedResult.cues, wellFormed, 'valid cues keep their values');
assert.ok(
  wellFormedResult.cues.every((item, index) => item === wellFormed[index]),
  'valid cues are returned as the very same objects',
);
repairChecks++;
expectEqual(
  repairNonPositiveCueDurations([]),
  { cues: [], repairs: [] },
  'empty input stays empty',
);

// end = min(start + 800 ms, next distinct start - 100 ms); when the next cue
// starts within 100 ms the cue ends exactly where the next one starts.
const repairCases: Array<{
  name: string;
  cues: ReturnType<typeof timed>[];
  ends: number[];
}> = [
  {
    name: 'zero-length cue in the middle',
    cues: [
      timed('1', 0, 1000),
      timed('2', 5200, 5200),
      timed('3', 9000, 10000),
    ],
    ends: [1000, 6000, 10000],
  },
  {
    name: 'zero-length last cue',
    cues: [timed('1', 0, 1000), timed('2', 5200, 5200)],
    ends: [1000, 6000],
  },
  {
    name: 'zero-length first cue stops before the next start',
    cues: [timed('1', 0, 0), timed('2', 500, 1500)],
    ends: [400, 1500],
  },
  {
    name: 'only cue',
    cues: [timed('1', 0, 0)],
    ends: [800],
  },
  {
    name: 'inverted cue',
    cues: [timed('1', 5200, 4800), timed('2', 9000, 10000)],
    ends: [6000, 10000],
  },
  {
    name: 'next start within the guard gap touches the next start',
    cues: [timed('1', 1000, 1000), timed('2', 1050, 2000)],
    ends: [1050, 2000],
  },
  {
    name: 'next start leaves room for the 100 ms guard',
    cues: [timed('1', 1000, 1000), timed('2', 1300, 2000)],
    ends: [1200, 2000],
  },
  {
    name: 'stacked identical starts share the next distinct start',
    cues: [
      timed('1', 5200, 5200),
      timed('2', 5200, 5200),
      timed('3', 9000, 10000),
    ],
    ends: [6000, 6000, 10000],
  },
  {
    name: 'consecutive zero-length cues',
    cues: [
      timed('1', 1000, 1000),
      timed('2', 1500, 1500),
      timed('3', 3000, 3500),
    ],
    ends: [1400, 2300, 3500],
  },
  {
    name: 'array order does not matter',
    cues: [timed('b', 9000, 10000), timed('a', 5200, 5200)],
    ends: [10000, 6000],
  },
];
for (const { name, cues, ends } of repairCases) {
  const repaired = repairNonPositiveCueDurations(cues);
  expectEqual(
    repaired.cues.map((cue) => cue.endMs),
    ends,
    `${name}: end times`,
  );
  expectEqual(
    repaired.cues.map((cue) => cue.startMs),
    cues.map((cue) => cue.startMs),
    `${name}: start times are never moved`,
  );
  expectValid(repaired.cues, `${name}: repaired cues pass the strict reader`);
  expectEqual(
    repairNonPositiveCueDurations(repaired.cues).repairs,
    [],
    `${name}: repairing twice changes nothing`,
  );
}

expectEqual(
  repairNonPositiveCueDurations([
    timed('1', 0, 1000),
    timed('2', 5200, 5200),
    timed('3', 9000, 4000),
  ]).repairs,
  [
    { index: 1, id: '2', startMs: 5200, endMs: 5200, repairedEndMs: 6000 },
    { index: 2, id: '3', startMs: 9000, endMs: 4000, repairedEndMs: 9800 },
  ],
  'repairs report what was found and what it became',
);

const frozen = Object.freeze({
  ...timed('2', 5200, 5200),
  speakerIds: [1],
  primarySpeakerId: 1,
});
expectEqual(
  repairNonPositiveCueDurations([frozen]).cues[0],
  { ...frozen, endMs: 6000 },
  'a repaired cue keeps every other field and the input is not mutated',
);

// Anything that is not a plain non-negative integer range is a real
// corruption, not a timing quirk: leave it for the strict reader to reject.
const corrupt: unknown[] = [
  { ...timed('1', 1000, 1000), startMs: '1000' },
  { ...timed('2', 1000, 1000), endMs: null },
  timed('3', -5, -5),
  timed('4', 1000.5, 1000.5),
  timed('5', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  null,
  'text',
];
const corruptResult = repairNonPositiveCueDurations(corrupt);
expectEqual(corruptResult.repairs, [], 'corrupt cues are not repaired');
assert.ok(
  corruptResult.cues.every((item, index) => item === corrupt[index]),
  'corrupt cues are returned untouched',
);
repairChecks++;
for (const item of corrupt) {
  assert.throws(
    () =>
      assertValidProofreadData({
        version: 2,
        speakers: [],
        cues: repairNonPositiveCueDurations([item]).cues,
      }),
    `corrupt cue ${JSON.stringify(item)} is still rejected`,
  );
  repairChecks++;
}

// Rejections must say which cue broke which rule: issue #511 only ever showed
// a file path, which made a perfectly valid JSON file look corrupted.
let messageChecks = 0;
const rejectionCases: Array<{ name: string; cue: unknown; message: string }> = [
  {
    name: 'zero-length cue',
    cue: timed('b', 5200, 5200),
    message:
      'Invalid proofread cue #2 (id=b, startMs=5200, endMs=5200): endMs is not after startMs',
  },
  {
    name: 'inverted cue',
    cue: timed('c', 5200, 4800),
    message:
      'Invalid proofread cue #2 (id=c, startMs=5200, endMs=4800): endMs is not after startMs',
  },
  {
    name: 'text start time',
    cue: { ...timed('d', 1000, 2000), startMs: '1000' },
    message:
      'Invalid proofread cue #2 (id=d, startMs="1000", endMs=2000): startMs is not an integer',
  },
  {
    name: 'missing end time',
    cue: { ...timed('e', 0, 1), endMs: null },
    message:
      'Invalid proofread cue #2 (id=e, startMs=0, endMs=null): endMs is not an integer',
  },
  {
    name: 'negative start time',
    cue: timed('f', -5, 10),
    message:
      'Invalid proofread cue #2 (id=f, startMs=-5, endMs=10): startMs is negative',
  },
  {
    name: 'non-text source',
    cue: { ...timed('g', 0, 1), source: { text: 'lost' } },
    message:
      'Invalid proofread cue #2 (id=g, startMs=0, endMs=1): source is not text',
  },
  {
    name: 'non-text target',
    cue: { ...timed('h', 0, 1), target: ['lost'] },
    message:
      'Invalid proofread cue #2 (id=h, startMs=0, endMs=1): target is not text',
  },
  {
    name: 'invalid speaker ids',
    cue: { ...timed('i', 0, 1), speakerIds: [0] },
    message:
      'Invalid proofread cue #2 (id=i, startMs=0, endMs=1): speakerIds is invalid',
  },
  {
    name: 'invalid primary speaker',
    cue: { ...timed('j', 0, 1), primarySpeakerId: '1' },
    message:
      'Invalid proofread cue #2 (id=j, startMs=0, endMs=1): primarySpeakerId is invalid',
  },
  {
    name: 'cue without an id falls back to its position',
    cue: { startMs: 5, endMs: 5, source: '' },
    message:
      'Invalid proofread cue #2 (id=2, startMs=5, endMs=5): endMs is not after startMs',
  },
  {
    name: 'null cue',
    cue: null,
    message: 'Invalid proofread cue #2 (null): not an object',
  },
  {
    name: 'text instead of a cue',
    cue: 'text',
    message: 'Invalid proofread cue #2 ("text"): not an object',
  },
  {
    name: 'long garbage values are shortened',
    cue: { ...timed('k', 0, 1), startMs: 'x'.repeat(100) },
    message: `Invalid proofread cue #2 (id=k, startMs="${'x'.repeat(36)}..., endMs=1): startMs is not an integer`,
  },
];
for (const { name, cue, message } of rejectionCases) {
  assert.throws(
    () =>
      assertValidProofreadData({
        version: 2,
        speakers: [],
        cues: [timed('a', 0, 1000), cue],
      }),
    { message },
    `${name}: the message names the cue and the broken rule`,
  );
  messageChecks++;
}

console.log(
  `Proofread strict parsing: ${checks + 9 + repairChecks + messageChecks} checks passed`,
);
