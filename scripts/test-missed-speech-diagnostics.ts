import {
  detectMissedSpeech,
  normalizeSpeechIntervals,
} from '../main/helpers/missedSpeechWarning';
import { summarizeMissedSpeech } from '../types/missedSpeech';
import { associateMissedSpeechWarnings } from '../types/missedSpeech';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

// Recognition segment-shaped data must never be accepted as VAD evidence.
assert(
  normalizeSpeechIntervals([{ start: 1, end: 2 }]).length === 0,
  'reject second-based/unknown interval shape',
);
assert(
  normalizeSpeechIntervals([
    { startMs: 1000, endMs: 2000 },
    { startMs: NaN, endMs: 2 },
  ]).length === 1,
  'sanitize diagnostics intervals',
);

const base = {
  durationMs: 10_000,
  energySegments: [{ startMs: 2_000, endMs: 4_000 }],
  cues: [{ id: '1', startMs: 0, endMs: 1_000, text: 'hello' }],
};

const withVad = detectMissedSpeech({
  ...base,
  vadAvailable: true,
  vadSegments: [{ startMs: 2_000, endMs: 4_000 }],
});
assert(
  withVad.length === 1 && withVad[0].signals.includes('engineVad'),
  'independent VAD supports a missed-speech warning',
);

const withoutVad = detectMissedSpeech({
  ...base,
  vadAvailable: false,
  vadSegments: [],
});
assert(withoutVad.length === 0, 'energy alone does not produce a warning');

const withSubtitleGap = detectMissedSpeech({
  durationMs: 10_000,
  energySegments: [{ startMs: 2_000, endMs: 4_000 }],
  cues: [
    { id: '1', startMs: 0, endMs: 1_000, text: 'hello' },
    { id: '2', startMs: 5_000, endMs: 6_000, text: 'world' },
  ],
});
assert(
  withSubtitleGap.length === 1 &&
    withSubtitleGap[0].level === 'medium' &&
    withSubtitleGap[0].signals.includes('subtitleGap'),
  'subtitle coverage gap plus energy produces a medium warning',
);

const withWordGap = detectMissedSpeech({
  durationMs: 10_000,
  energySegments: [{ startMs: 2_000, endMs: 4_000 }],
  wordSegments: [
    { startMs: 1_000, endMs: 1_500 },
    { startMs: 4_500, endMs: 5_000 },
  ],
  cues: [{ id: '1', startMs: 0, endMs: 6_000, text: 'hello world' }],
});
assert(
  withWordGap.length === 1 &&
    withWordGap[0].level === 'low' &&
    withWordGap[0].signals.includes('wordGap'),
  'interior word timeline gap plus energy produces a low warning',
);

const withBothCoverageSignals = detectMissedSpeech({
  durationMs: 10_000,
  energySegments: [{ startMs: 2_000, endMs: 4_000 }],
  wordSegments: [
    { startMs: 1_000, endMs: 1_500 },
    { startMs: 4_500, endMs: 5_000 },
  ],
  cues: [
    { id: '1', startMs: 0, endMs: 1_000, text: 'hello' },
    { id: '2', startMs: 5_000, endMs: 6_000, text: 'world' },
  ],
});
assert(
  withBothCoverageSignals.length === 1 &&
    withBothCoverageSignals[0].level === 'medium' &&
    withBothCoverageSignals[0].signals.includes('wordGap') &&
    withBothCoverageSignals[0].signals.includes('subtitleGap'),
  'subtitle gap keeps medium severity when a word gap also overlaps',
);

const shortGap = detectMissedSpeech({
  ...base,
  energySegments: [{ startMs: 2_000, endMs: 2_799 }],
  vadSegments: [{ startMs: 2_000, endMs: 2_799 }],
});
assert(shortGap.length === 0, 'sub-800ms candidate is ignored');

const cueAssociations = associateMissedSpeechWarnings(
  [
    {
      id: 'warning',
      startMs: 2_000,
      endMs: 4_000,
      level: 'high',
      signals: ['energySpeech', 'engineVad'],
      cueIds: [],
    },
  ],
  [
    { id: 'a', startMs: 1_000, endMs: 2_500 },
    { id: 'b', startMs: 3_500, endMs: 5_000 },
  ],
);
assert(
  cueAssociations.length === 1 && cueAssociations[0].cueIds.join(',') === 'a,b',
  'warning associates every overlapping cue in order',
);
assert(
  summarizeMissedSpeech(withVad, true).engineVadAvailable === true,
  'summary records available VAD capability',
);
assert(
  summarizeMissedSpeech(withVad, false).engineVadAvailable === false,
  'summary distinguishes unavailable VAD',
);

// Missing word timestamps at either endpoint are intentionally ignored.
const endpointWords = detectMissedSpeech({
  durationMs: 10_000,
  energySegments: [{ startMs: 0, endMs: 1_000 }],
  wordSegments: [{ startMs: 0, endMs: 500 }],
  cues: [{ id: '1', startMs: 0, endMs: 1_000, text: 'hello' }],
});
assert(endpointWords.length === 0, 'do not infer endpoint word gaps');

console.log('All missed speech diagnostics tests passed');
