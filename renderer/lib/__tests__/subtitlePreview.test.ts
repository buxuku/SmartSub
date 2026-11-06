import {
  convertSubtitleContent,
  formatSrtTime,
  parseSubtitleCues,
} from '../../../main/helpers/subtitleFormats';
import type { Subtitle } from '../../hooks/useSubtitles';
import { buildPreviewTrackSpecs, buildPreviewVtt } from '../subtitlePreview';

const row = (overrides: Partial<Subtitle> = {}): Subtitle => ({
  id: '1',
  startEndTime: '00:00:01,000 --> 00:00:02,500',
  content: ['Hello'],
  sourceContent: 'Hello',
  targetContent: 'Bonjour',
  startTimeInSeconds: 1,
  endTimeInSeconds: 2.5,
  ...overrides,
});

const second = (overrides: Partial<Subtitle> = {}): Subtitle =>
  row({
    id: '2',
    startEndTime: '00:00:03,000 --> 00:00:04,000',
    content: ['World'],
    sourceContent: 'World',
    targetContent: 'Monde',
    startTimeInSeconds: 3,
    endTimeInSeconds: 4,
    ...overrides,
  });

describe('buildPreviewVtt', () => {
  it('renders every valid row as a WebVTT cue', () => {
    expect(buildPreviewVtt([row(), second()], 'sourceContent')).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:02.500\nHello\n\n' +
        '00:00:03.000 --> 00:00:04.000\nWorld\n\n',
    );
  });

  it('reads the translation from targetContent', () => {
    expect(buildPreviewVtt([row()], 'targetContent')).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nBonjour\n\n',
    );
  });

  it('matches what converting the SRT file used to produce', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      'Hello',
      '',
      '2',
      '00:01:03,200 --> 00:01:05,000',
      'Two lines',
      'of text',
      '',
      '',
    ].join('\n');
    const rows = parseSubtitleCues(srt, 'srt').map((cue, index) =>
      row({
        id: String(index + 1),
        startEndTime: `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`,
        content: cue.text.split('\n'),
        sourceContent: cue.text,
        startTimeInSeconds: cue.startMs / 1000,
        endTimeInSeconds: cue.endMs / 1000,
      }),
    );

    expect(buildPreviewVtt(rows, 'sourceContent')).toBe(
      convertSubtitleContent(srt, 'srt', 'vtt'),
    );
  });

  it('shows the edited text instead of the original content lines', () => {
    const vtt = buildPreviewVtt(
      [row({ content: ['Old'], sourceContent: 'Edited' })],
      'sourceContent',
    );

    expect(vtt).toContain('Edited');
    expect(vtt).not.toContain('Old');
  });

  it('falls back to the content lines when sourceContent is absent', () => {
    const vtt = buildPreviewVtt(
      [row({ content: ['First', 'Second'], sourceContent: undefined })],
      'sourceContent',
    );

    expect(vtt).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nFirst\nSecond\n\n',
    );
  });

  it('treats a missing translation as empty', () => {
    expect(
      buildPreviewVtt([row({ targetContent: undefined })], 'targetContent'),
    ).toBeNull();
  });

  it('rounds second based times to whole milliseconds', () => {
    const vtt = buildPreviewVtt(
      [row({ startTimeInSeconds: 0.1 + 0.2, endTimeInSeconds: 3599.9996 })],
      'sourceContent',
    );

    expect(vtt).toContain('00:00:00.300 --> 01:00:00.000');
  });

  it('falls back to startEndTime when the second based times are missing', () => {
    const vtt = buildPreviewVtt(
      [
        row({
          startEndTime: '00:01:02,345 --> 00:01:03,000',
          startTimeInSeconds: undefined,
          endTimeInSeconds: undefined,
        }),
      ],
      'sourceContent',
    );

    expect(vtt).toContain('00:01:02.345 --> 00:01:03.000');
  });

  it('skips rows with blank text or an unusable time range', () => {
    const vtt = buildPreviewVtt(
      [
        row({ id: 'blank', sourceContent: '  \n ' }),
        row({ id: 'reversed', startTimeInSeconds: 5, endTimeInSeconds: 4 }),
        row({ id: 'empty-range', startTimeInSeconds: 2, endTimeInSeconds: 2 }),
        row({
          id: 'garbage',
          startEndTime: 'garbage',
          startTimeInSeconds: Number.NaN,
          endTimeInSeconds: Number.NaN,
        }),
        second(),
      ],
      'sourceContent',
    );

    expect(vtt).toBe('WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nWorld\n\n');
  });

  it('returns null when no cue can be shown', () => {
    expect(buildPreviewVtt([], 'sourceContent')).toBeNull();
    expect(
      buildPreviewVtt([row({ sourceContent: ' ' })], 'sourceContent'),
    ).toBeNull();
  });

  it('collapses blank lines so one cue cannot be split in two', () => {
    const vtt = buildPreviewVtt(
      [row({ sourceContent: 'First\n\n  \nSecond' })],
      'sourceContent',
    );

    expect(vtt).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nFirst\nSecond\n\n',
    );
  });

  it('normalizes Windows line endings', () => {
    const vtt = buildPreviewVtt(
      [row({ sourceContent: 'one\r\ntwo\rthree' })],
      'sourceContent',
    );

    expect(vtt).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\none\ntwo\nthree\n\n',
    );
  });

  it('escapes the cue timing arrow typed into the text', () => {
    const vtt = buildPreviewVtt(
      [row({ sourceContent: 'start --> end' })],
      'sourceContent',
    );

    expect(vtt).toContain('\nstart --&gt; end\n');
    expect(vtt?.match(/-->/g)).toHaveLength(1);
  });
});

describe('buildPreviewTrackSpecs', () => {
  const pick = (specs: ReturnType<typeof buildPreviewTrackSpecs>) =>
    specs.map(({ role, srcLang, label, default: isDefault }) => ({
      role,
      srcLang,
      label,
      default: isDefault,
    }));

  it('builds a source and a target track and shows the translation by default', () => {
    const specs = buildPreviewTrackSpecs([row(), second()], {
      source: 'en',
      target: 'fr',
    });

    expect(pick(specs)).toEqual([
      { role: 'source', srcLang: 'en', label: '(en)', default: false },
      { role: 'target', srcLang: 'fr', label: '(fr)', default: true },
    ]);
    expect(specs[0].vtt).toContain('Hello');
    expect(specs[1].vtt).toContain('Bonjour');
  });

  it('shows the source by default when nothing is translated yet', () => {
    const specs = buildPreviewTrackSpecs(
      [row({ targetContent: '' }), second({ targetContent: ' ' })],
      { source: 'en', target: 'fr' },
    );

    expect(pick(specs)).toEqual([
      { role: 'source', srcLang: 'en', label: '(en)', default: true },
    ]);
  });

  it('keeps the translation track once the user types the first translation', () => {
    const specs = buildPreviewTrackSpecs(
      [row({ targetContent: '' }), second({ targetContent: 'Monde' })],
      { source: 'en', target: 'fr' },
    );

    expect(specs.map((spec) => [spec.role, spec.default])).toEqual([
      ['source', false],
      ['target', true],
    ]);
  });

  it('does not depend on language metadata', () => {
    const specs = buildPreviewTrackSpecs([row()], {});

    expect(pick(specs)).toEqual([
      { role: 'source', srcLang: 'und', label: 'source', default: false },
      { role: 'target', srcLang: 'und', label: 'target', default: true },
    ]);
  });

  it('uses a language only for the side that has one', () => {
    const specs = buildPreviewTrackSpecs([row()], {
      source: 'en',
      target: '   ',
    });

    expect(pick(specs)).toEqual([
      { role: 'source', srcLang: 'en', label: '(en)', default: false },
      { role: 'target', srcLang: 'und', label: 'target', default: true },
    ]);
  });

  it('omits a track that has no text', () => {
    const specs = buildPreviewTrackSpecs(
      [row({ sourceContent: '', content: [''] })],
      { source: 'en', target: 'fr' },
    );

    expect(pick(specs)).toEqual([
      { role: 'target', srcLang: 'fr', label: '(fr)', default: true },
    ]);
  });

  it('returns no tracks for an empty document', () => {
    expect(buildPreviewTrackSpecs([], { source: 'en', target: 'fr' })).toEqual(
      [],
    );
  });
});
