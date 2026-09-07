/// <reference path="./test-globals.d.ts" />

import { normalizeProofreadData } from '../types/proofreadData';

let passed = 0;
let failed = 0;

function ok(value: unknown, message: string): void {
  if (value) passed += 1;
  else {
    failed += 1;
    console.error(`\u2717 ${message}`);
  }
}

async function run(): Promise<void> {
  const warning = {
    startMs: 1000.4,
    endMs: 2300.8,
    level: 'medium',
    signals: ['subtitleGap'],
    cueIds: ['stale-id'],
  };
  const legacy = normalizeProofreadData({
    version: 1,
    meta: {},
    cues: [
      {
        id: 'cue-a',
        startMs: 0,
        endMs: 1000,
        source: 'a',
        target: '',
        missedSpeechWarnings: [warning],
      },
    ],
  });
  ok(!legacy.missedSpeechWarnings, 'incomplete warning evidence is rejected');
  const canonical = normalizeProofreadData({
    version: 2,
    meta: {},
    missedSpeechWarnings: [
      {
        startMs: 1000.4,
        endMs: 2300.8,
        level: 'medium',
        signals: ['energySpeech', 'subtitleGap'],
        cueIds: ['stale'],
      },
    ],
    cues: [{ id: 'cue-a', startMs: 0, endMs: 1000, source: 'a', target: '' }],
  });
  ok(
    canonical.missedSpeechWarnings?.[0].startMs === 1000 &&
      canonical.missedSpeechWarnings?.[0].endMs === 2301,
    'warning range is rounded to canonical milliseconds',
  );
  ok(
    canonical.missedSpeechWarnings?.[0].cueIds.length === 0,
    'non-overlapping file warning does not retain stale cue IDs',
  );

  const edited = normalizeProofreadData({
    version: 2,
    meta: {},
    missedSpeechWarnings: [
      {
        id: 'ignored',
        startMs: 1000,
        endMs: 2000,
        level: 'high',
        signals: ['energySpeech', 'subtitleGap'],
        cueIds: ['stale-id'],
      },
    ],
    cues: [
      { id: '1', startMs: 0, endMs: 1500, source: 'a', target: '' },
      { id: '2', startMs: 1500, endMs: 3000, source: 'b', target: '' },
    ],
  });
  ok(
    edited.missedSpeechWarnings?.[0].cueIds.join(',') === '1,2',
    'cue IDs are recomputed from current timing',
  );
  ok(
    edited.cues.every((cue) => cue.missedSpeechWarnings?.length === 1),
    'cue-local warning views follow updated overlap',
  );
}

run()
  .then(() => {
    console.log(`Missed speech data tests: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
