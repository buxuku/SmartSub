/// <reference path="./test-globals.d.ts" />

import {
  alignSpeakersToCues,
  annotateCuesWithSpeakers,
  normalizeDiarizationSegments,
  speakerIdsForCues,
  stripSpeakerLabelPrefix,
} from '../main/helpers/speakerDiarization/alignment';
import { normalizeDubbingSpeechText } from '../main/helpers/dubbing/textNormalization';
import {
  enforceSpeakerDiarizationTaskBoundary,
  getSpeakerDiarizationMetadataWarning,
  mergeSpeakerIds,
  normalizeSpeakerDiarizationCount,
  realignSpeakerIdsForCue,
  shouldEmbedSpeakerLabels,
  shouldExtractAudioForEmbeddedSubtitle,
  SPEAKER_DIARIZATION_METADATA_SAVE_FAILED,
  stripSpeakerDiarizationConfig,
} from '../types/speakerDiarization';
import {
  getFileWarning,
  getFileStages,
  isProofreadReady,
} from '../renderer/components/tasks/stageUtils';
import { isTaskSnapshotTranslationEnabled } from '../types/taskSnapshot';

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

equal(
  stripSpeakerLabelPrefix('[Speaker 1 + Speaker 2] Together'),
  'Together',
  'speaker metadata prefix can be removed without touching cue timing',
);

equal(
  normalizeDubbingSpeechText('[Speaker 1] Hello\nworld'),
  'Hello world',
  'TTS input strips a single-speaker label and keeps the spoken content',
);

equal(
  normalizeDubbingSpeechText('[Speaker 1 + Speaker 2] Together'),
  'Together',
  'TTS input strips an overlapping-speaker label',
);

equal(
  normalizeDubbingSpeechText('[Director] Keep this cue'),
  '[Director] Keep this cue',
  'TTS input preserves unrelated bracketed text',
);

equal(
  speakerIdsForCues(cues, segments),
  [[1], [2], []],
  'sidecar speaker metadata uses the same one-based ids as visible labels',
);

equal(
  shouldEmbedSpeakerLabels(undefined),
  false,
  'speaker labels are not embedded by default',
);

equal(
  shouldEmbedSpeakerLabels({ speakerDiarizationEmbedInSubtitle: true }),
  true,
  'speaker labels are embedded only when explicitly enabled',
);

equal(
  shouldExtractAudioForEmbeddedSubtitle({ speakerDiarization: true }),
  true,
  'embedded subtitle flow still extracts audio when diarization is enabled',
);

equal(
  shouldExtractAudioForEmbeddedSubtitle({
    speakerDiarization: true,
    recipeName: 'pipeline-recipe',
  }),
  false,
  'unsupported pipeline contexts do not extract audio for diarization',
);

equal(
  getSpeakerDiarizationMetadataWarning(true, false),
  SPEAKER_DIARIZATION_METADATA_SAVE_FAILED,
  'sidecar persistence failure is classified as a visible non-blocking warning',
);

equal(
  getSpeakerDiarizationMetadataWarning(true, true),
  undefined,
  'persisted speaker metadata does not produce a warning',
);

equal(
  mergeSpeakerIds([1], [2, 1], undefined),
  [1, 2],
  'merging subtitle cues preserves every distinct speaker id',
);

equal(
  realignSpeakerIdsForCue(
    0,
    4000,
    [
      { startMs: 0, endMs: 2000, speakerIds: [1] },
      { startMs: 2000, endMs: 4000, speakerIds: [2] },
    ],
    [1],
  ),
  [1, 2],
  'edited cue timing realigns metadata from every overlapping original cue',
);

equal(
  [
    normalizeSpeakerDiarizationCount(2),
    normalizeSpeakerDiarizationCount(8),
    normalizeSpeakerDiarizationCount(9),
    normalizeSpeakerDiarizationCount(1),
  ],
  [2, 8, -1, -1],
  'runtime speaker count is capped to the UI range 2-8',
);

equal(
  stripSpeakerDiarizationConfig({
    speakerDiarization: true,
    speakerDiarizationCount: 3,
    speakerDiarizationEmbedInSubtitle: true,
    translateProvider: 'provider-1',
  }),
  { translateProvider: 'provider-1' },
  'recipe and wizard sanitization removes every diarization setting',
);

equal(
  enforceSpeakerDiarizationTaskBoundary({
    speakerDiarization: true,
    speakerDiarizationCount: 2,
    speakerDiarizationEmbedInSubtitle: true,
    dub: { engine: { kind: 'local', modelId: 'vits-zh' } },
  }),
  { dub: { engine: { kind: 'local', modelId: 'vits-zh' } } },
  'runtime boundary disables diarization for pipeline tasks',
);

const generateOnly = {
  slug: 'generate',
  taskType: 'generateOnly' as const,
  accepts: 'media' as const,
  needsModel: true,
  hasTranslate: false,
};
const generateAndTranslate = {
  slug: 'generate-translate',
  taskType: 'generateAndTranslate' as const,
  accepts: 'media' as const,
  needsModel: true,
  hasTranslate: true,
};
const mediaFile = { filePath: 'interview.mp4' };

equal(
  isTaskSnapshotTranslationEnabled(
    { translateProvider: 'stale-provider-from-global-form' },
    false,
  ),
  false,
  'generate-only pinned snapshot hides stale translation configuration',
);

equal(
  isTaskSnapshotTranslationEnabled({ translateProvider: 'provider-1' }, true),
  true,
  'translation task pinned snapshot still shows its translation configuration',
);

equal(
  getFileStages(mediaFile, generateAndTranslate, {
    translateProvider: 'provider-1',
    speakerDiarization: true,
  }).map((stage) => stage.key),
  [
    'extractAudio',
    'extractSubtitle',
    'translateSubtitle',
    'speakerDiarization',
  ],
  'speaker diarization is a visible stage after translation',
);

equal(
  getFileStages(
    { ...mediaFile, providedSubtitlePath: 'interview.srt' },
    generateAndTranslate,
    { translateProvider: 'provider-1', speakerDiarization: true },
  ).map((stage) => stage.key),
  ['translateSubtitle'],
  'paired subtitle input does not expose the diarization stage',
);

equal(
  isProofreadReady(
    {
      ...mediaFile,
      extractSubtitle: 'done',
      speakerDiarization: 'loading',
    },
    generateOnly,
    { speakerDiarization: true },
  ),
  false,
  'proofread remains locked while diarization is loading',
);

equal(
  isProofreadReady(
    {
      ...mediaFile,
      extractSubtitle: 'done',
      speakerDiarization: 'done',
    },
    generateOnly,
    { speakerDiarization: true },
  ),
  true,
  'proofread unlocks after diarization and sidecar writing finish',
);

equal(
  isProofreadReady(
    {
      ...mediaFile,
      translateSubtitle: 'done',
      speakerDiarization: 'loading',
    },
    generateAndTranslate,
    { translateProvider: 'provider-1', speakerDiarization: true },
  ),
  false,
  'translated tasks also wait for diarization before proofreading',
);

equal(
  getFileWarning(
    {
      ...mediaFile,
      speakerDiarization: 'done',
      speakerDiarizationError: SPEAKER_DIARIZATION_METADATA_SAVE_FAILED,
    },
    getFileStages(mediaFile, generateOnly, { speakerDiarization: true }),
  ),
  SPEAKER_DIARIZATION_METADATA_SAVE_FAILED,
  'completed diarization surfaces sidecar persistence failures as warnings',
);

console.log(`✓ speaker diarization alignment tests passed (${passed})`);
