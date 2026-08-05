import {
  PROOFREAD_DATA_VERSION,
  SPEAKER_COLOR_PALETTE,
  countSpeakerCues,
  createDefaultSpeaker,
  hasExplicitSpeakerAssignment,
  moveSpeakerAssignments,
  nextSpeakerId,
  normalizeProofreadData,
  normalizeSpeakerAssignment,
  normalizeSpeakerIds,
  orderedSpeakerIds,
  prefixTextWithSpeakerNames,
  sanitizeSpeakerDisplayName,
  shouldRealignSpeakerAssignment,
  speakerListsEqual,
  type ProofreadDataCue,
  type SpeakerInfo,
} from '../types/proofreadData';

let passed = 0;
let failed = 0;

function check(condition: unknown, message: string): void {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`✗ ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`,
  );
}

const meta = {
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

const migrated = normalizeProofreadData({
  version: 1,
  meta,
  cues: [
    {
      id: '1',
      startMs: 0,
      endMs: 1000,
      source: 'hello',
      target: '',
      speakerIds: [2, 1, 2, -1],
    },
    {
      id: '2',
      startMs: 1000,
      endMs: 2000,
      source: 'world',
      target: '',
    },
  ],
});

equal(migrated.version, PROOFREAD_DATA_VERSION, 'v1 migrates to v2');
equal(
  migrated.speakers.map((speaker) => speaker.id),
  [1, 2],
  'v1 migration creates a sorted roster for referenced IDs',
);
equal(
  migrated.cues[0].speakerIds,
  [2, 1],
  'cue assignment preserves semantic order while removing duplicates',
);
equal(
  migrated.cues[0].primarySpeakerId,
  2,
  'v1 migration makes the original first role explicit primary',
);
check(
  migrated.speakers.every((speaker) => speaker.autoName),
  'generated roster names remain localizable',
);
check(
  migrated.speakers.every((speaker) =>
    SPEAKER_COLOR_PALETTE.includes(speaker.color as any),
  ),
  'generated speakers use the stable palette',
);
check(
  !Object.prototype.hasOwnProperty.call(migrated.cues[1], 'speakerIds'),
  'migration keeps missing role metadata distinct from explicit unassigned',
);

const normalizedV2 = normalizeProofreadData({
  version: 2,
  meta,
  speakers: [
    { id: 2, displayName: 'Host', color: '#dc2626' },
    { id: 2, displayName: 'Duplicate', color: '#2563eb' },
    { id: 4, displayName: '  Guest  ', color: 'invalid' },
  ],
  cues: [
    {
      id: '1',
      startMs: 0,
      endMs: 1000,
      source: 'x',
      target: '',
      speakerIds: [4, 3],
      primarySpeakerId: 99,
    },
  ],
});

equal(
  normalizedV2.speakers.map((speaker) => speaker.id),
  [2, 4, 3],
  'v2 keeps roster order, removes duplicates and appends missing references',
);
equal(
  normalizedV2.speakers[0].displayName,
  'Host',
  'renamed speaker survives normalization',
);
equal(
  normalizedV2.speakers[1].displayName,
  'Guest',
  'speaker names are trimmed',
);
equal(
  normalizedV2.cues[0].primarySpeakerId,
  4,
  'invalid explicit primary falls back to first assigned role',
);

equal(
  normalizeSpeakerIds([3, 1, 3, 0, 2.5, 2]),
  [3, 1, 2],
  'speaker ID normalization is stable and rejects invalid IDs',
);
equal(
  normalizeSpeakerAssignment({
    speakerIds: [],
    primarySpeakerId: 2,
    speakerAssignmentSource: 'manual' as const,
  }),
  { speakerIds: [], speakerAssignmentSource: 'manual' },
  'explicit unassigned survives normalization without a fake primary role',
);
equal(
  orderedSpeakerIds({ speakerIds: [1, 3, 2], primarySpeakerId: 3 }),
  [3, 1, 2],
  'primary role renders first without mutating full assignment',
);

const cues: ProofreadDataCue[] = [
  {
    id: '1',
    startMs: 0,
    endMs: 1000,
    source: 'a',
    target: '',
    speakerIds: [1, 2],
    primarySpeakerId: 1,
  },
  {
    id: '2',
    startMs: 1000,
    endMs: 2000,
    source: 'b',
    target: '',
    speakerIds: [1],
    primarySpeakerId: 1,
  },
  {
    id: '3',
    startMs: 2000,
    endMs: 3000,
    source: 'c',
    target: '',
  },
];
const moved = moveSpeakerAssignments(cues, 1, 2);
equal(
  moved[0].speakerIds,
  [2],
  'moving a role deduplicates overlap with the target',
);
equal(
  moved[0].primarySpeakerId,
  2,
  'moving a primary role promotes the target',
);
equal(moved[1].speakerIds, [2], 'moving a role updates every associated cue');
equal(moved[2], cues[2], 'moving a role preserves unrelated cue content');
equal(
  countSpeakerCues(cues, 1),
  2,
  'role cue count includes overlap cues once',
);

const roster: SpeakerInfo[] = [
  createDefaultSpeaker(1, 'Host]'),
  { ...createDefaultSpeaker(2, 'Guest'), autoName: false },
];
equal(nextSpeakerId(roster), 3, 'next role ID follows used IDs');
equal(
  nextSpeakerId([createDefaultSpeaker(1), createDefaultSpeaker(3)]),
  2,
  'next role ID fills stable gaps',
);
equal(
  prefixTextWithSpeakerNames(
    'Hello',
    { speakerIds: [1, 2], primarySpeakerId: 2 },
    roster,
  ),
  '[Guest + Host］] Hello',
  'deliverable prefix uses primary-first display names and escapes brackets',
);
equal(
  prefixTextWithSpeakerNames('Hello', {}, roster),
  'Hello',
  'unassigned text is never prefixed',
);
equal(
  sanitizeSpeakerDisplayName('  Host\n\tName  '),
  'Host Name',
  'speaker names remove control characters and collapse whitespace',
);
check(
  speakerListsEqual(
    roster,
    roster.map((speaker) => ({ ...speaker })),
  ),
  'speaker roster equality accepts immutable clones',
);
check(
  !speakerListsEqual(roster, [{ ...roster[0], color: '#16a34a' }, roster[1]]),
  'speaker roster equality detects color changes for undo history',
);

const explicitUnassigned = normalizeProofreadData({
  version: 2,
  meta,
  speakers: roster,
  cues: [
    {
      id: '1',
      startMs: 0,
      endMs: 1000,
      source: 'Hello',
      target: '',
      speakerIds: [],
      speakerAssignmentSource: 'manual',
    },
  ],
});
equal(
  explicitUnassigned.cues[0].speakerIds,
  [],
  'sidecar normalization persists explicit unassigned',
);
equal(
  explicitUnassigned.cues[0].speakerAssignmentSource,
  'manual',
  'sidecar normalization persists manual assignment precedence',
);
check(
  hasExplicitSpeakerAssignment(explicitUnassigned.cues[0]),
  'explicit unassigned remains distinguishable after reopening',
);
check(
  !shouldRealignSpeakerAssignment(true, 'manual'),
  'timing edits never realign a manual role correction',
);
check(
  shouldRealignSpeakerAssignment(true),
  'timing edits can still realign untouched automatic assignments',
);

console.log(`proofread speakers: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
