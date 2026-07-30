import {
  alignSpeakersToCues,
  annotateCuesWithSpeakers,
  normalizeDiarizationSegments,
} from '../main/helpers/speakerDiarization/alignment';

let passed = 0;

function equal(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}\nexpected: ${e}\nactual:   ${a}`);
  }
  passed += 1;
}

const cues = [
  { startMs: 0, endMs: 2000, text: 'Hello' },
  { startMs: 2000, endMs: 4000, text: 'World' },
  { startMs: 5000, endMs: 6000, text: 'Unknown' },
];

const segments = [
  { start: 0, end: 1.8, speaker: 0 },
  { start: 1.6, end: 2.5, speaker: 1 },
  { start: 2.5, end: 4, speaker: 1 },
];

equal(
  alignSpeakersToCues(cues, segments).map((item) => item.speakers),
  [[0], [1], []],
  'assigns the speaker with the largest temporal overlap',
);

equal(
  annotateCuesWithSpeakers(cues, segments).map((cue) => cue.text),
  ['[Speaker 1] Hello', '[Speaker 2] World', 'Unknown'],
  'annotates matched cues and leaves unknown cues readable',
);

equal(
  annotateCuesWithSpeakers(
    [{ startMs: 0, endMs: 2000, text: 'Together' }],
    [
      { start: 0, end: 2, speaker: 0 },
      { start: 0.5, end: 1.7, speaker: 1 },
    ],
  )[0].text,
  '[Speaker 1 + Speaker 2] Together',
  'marks meaningful overlapping speech with both speakers',
);

equal(
  annotateCuesWithSpeakers(
    [{ startMs: 0, endMs: 2000, text: '[Speaker 9] Retry' }],
    [{ start: 0, end: 2, speaker: 1 }],
  )[0].text,
  '[Speaker 2] Retry',
  'annotation is idempotent across retries',
);

equal(
  normalizeDiarizationSegments([
    { start: 2, end: 1, speaker: 0 },
    { start: Number.NaN, end: 2, speaker: 0 },
    { start: 1, end: 2, speaker: -1 },
    { start: 3, end: 4, speaker: 2 },
    { start: 0, end: 1, speaker: 1 },
  ]),
  [
    { start: 0, end: 1, speaker: 1 },
    { start: 3, end: 4, speaker: 2 },
  ],
  'invalid native segments are ignored and valid segments are sorted',
);

equal(
  alignSpeakersToCues(
    [{ startMs: 0, endMs: 2000, text: 'Boundary' }],
    [
      { start: 0, end: 1.95, speaker: 0 },
      { start: 1.95, end: 2, speaker: 1 },
    ],
  )[0].speakers,
  [0],
  'tiny boundary overlap does not create a false overlap label',
);

console.log(`✓ speaker diarization alignment tests passed (${passed})`);
