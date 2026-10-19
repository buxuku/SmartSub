import {
  describeEmbeddedTrack,
  embeddedSubtitleFileName,
  embeddedSubtitleProbeFiles,
  findEmbeddedSubtitleHit,
} from '../embeddedSubtitleScan';
import { EMBEDDED_SCAN_RESPONSE_TIMEOUT_MS } from '../../../types/embeddedSubtitle';

const media = { needsModel: true };
const file = (filePath: string, providedSubtitlePath?: string) => ({
  filePath,
  providedSubtitlePath,
});

describe('which files are worth probing before a start', () => {
  test('media files that still need a transcript, in list order', () => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: media,
        files: [file('/a.mkv'), file('/b.mp4'), file('/c.mov')],
        formData: {},
      }),
    ).toEqual(['/a.mkv', '/b.mp4', '/c.mov']);
  });

  test('not subtitle files, not files that already have a paired subtitle', () => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: media,
        files: [
          file('/a.mkv'),
          file('/b.srt'),
          file('/c.mp4', '/c.srt'),
          file('/d.ass'),
        ],
        formData: {},
      }),
    ).toEqual(['/a.mkv']);
  });

  test.each([
    ['unset', undefined],
    ['explicitly on', true],
  ])('asks when the switch is %s', (_name, useEmbeddedSubtitles) => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: media,
        files: [file('/a.mkv')],
        formData: { useEmbeddedSubtitles },
      }),
    ).toEqual(['/a.mkv']);
  });

  test('does not ask once speech recognition is forced', () => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: media,
        files: [file('/a.mkv')],
        formData: { useEmbeddedSubtitles: false },
      }),
    ).toEqual([]);
  });

  test('does not ask for a task that does not transcribe', () => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: { needsModel: false },
        files: [file('/a.mkv')],
        formData: {},
      }),
    ).toEqual([]);
  });

  test('ignores list entries without a path', () => {
    expect(
      embeddedSubtitleProbeFiles({
        typeDef: media,
        files: [file(''), file('/a.mkv'), undefined as any],
        formData: {},
      }),
    ).toEqual(['/a.mkv']);
  });
});

describe('how a track is named in the question', () => {
  test.each([
    ['subrip', 'SubRip'],
    ['ass', 'ASS'],
    ['ssa', 'SSA'],
    ['mov_text', 'MOV Text'],
    ['webvtt', 'WebVTT'],
    ['somethingnew', 'SOMETHINGNEW'],
  ])('shows codec %s as %s', (codec, label) => {
    expect(describeEmbeddedTrack({ language: 'eng', codec }, 'en', '?')).toBe(
      `English · ${label}`,
    );
  });

  test('names the language in the language of the interface', () => {
    const track = { language: 'jpn', codec: 'subrip' };
    expect(describeEmbeddedTrack(track, 'en', '?')).toBe('Japanese · SubRip');
    expect(describeEmbeddedTrack(track, 'zh', '?')).toBe('日语 · SubRip');
  });

  test('shows a language code it cannot name as it is, rather than dropping the track', () => {
    expect(
      describeEmbeddedTrack({ language: 'x_bad!', codec: 'ass' }, 'en', '?'),
    ).toBe('x_bad! · ASS');
  });

  test('says so when the track does not declare a language', () => {
    expect(describeEmbeddedTrack({ codec: 'ass' }, 'en', 'Unknown')).toBe(
      'Unknown · ASS',
    );
  });
});

describe('the file name in the question', () => {
  test.each([
    ['/media/lesson 1.mkv', 'lesson 1.mkv'],
    ['C:\\Videos\\lesson 1.mkv', 'lesson 1.mkv'],
    ['lesson.mkv', 'lesson.mkv'],
    ['/media/', '/media/'],
  ])('%s is shown as %s', (path, name) => {
    expect(embeddedSubtitleFileName(path)).toBe(name);
  });
});

describe('asking the main process', () => {
  const hit = {
    filePath: '/media/a.mkv',
    tracks: [{ language: 'eng', codec: 'subrip' }],
  };
  const input = {
    typeDef: media,
    files: [file('/media/a.mkv'), file('/media/b.srt')],
    formData: {},
  };
  let settings: unknown;
  let scan: (payload: unknown) => unknown;
  let channels: string[];

  beforeEach(() => {
    settings = {};
    scan = () => ({ status: 'found', hit });
    channels = [];
    window.ipc = {
      invoke: jest.fn(async (channel: string, payload?: unknown) => {
        channels.push(channel);
        if (channel === 'getSettings') {
          if (settings instanceof Error) throw settings;
          return settings;
        }
        return scan(payload);
      }),
    } as any;
  });
  afterEach(() => jest.useRealTimers());

  test('hands back the first hit and sends only the probe files', async () => {
    await expect(findEmbeddedSubtitleHit(input)).resolves.toEqual(hit);
    expect(window.ipc.invoke).toHaveBeenCalledWith('findEmbeddedSubtitles', {
      filePaths: ['/media/a.mkv'],
    });
  });

  test.each([
    ['nothing found', { status: 'none' }],
    ['the budget ran out', { status: 'unknown' }],
    ['a hit without a path', { status: 'found', hit: { tracks: hit.tracks } }],
    ['a hit without tracks', { status: 'found', hit: { ...hit, tracks: [] } }],
    ['a hit that says none', { status: 'none', hit }],
    ['no answer at all', undefined],
  ])('is null for %s', async (_name, answer) => {
    scan = () => answer;
    await expect(findEmbeddedSubtitleHit(input)).resolves.toBeNull();
  });

  test('is null, and quiet, when the probe or the settings fail', async () => {
    scan = () => {
      throw new Error('spawn failed');
    };
    await expect(findEmbeddedSubtitleHit(input)).resolves.toBeNull();
    settings = new Error('EIO');
    await expect(findEmbeddedSubtitleHit(input)).resolves.toBeNull();
  });

  test('asks the main process nothing when the prompt is switched off', async () => {
    settings = { embeddedSubtitlePrompt: false };
    await expect(findEmbeddedSubtitleHit(input)).resolves.toBeNull();
    expect(channels).toEqual(['getSettings']);
  });

  test('does not even read the settings when there is nothing to probe', async () => {
    await expect(
      findEmbeddedSubtitleHit({
        ...input,
        formData: { useEmbeddedSubtitles: false },
      }),
    ).resolves.toBeNull();
    expect(channels).toEqual([]);
  });

  test('gives up on a main process that never answers, just after its own budget', async () => {
    jest.useFakeTimers();
    scan = () => new Promise(() => {});
    let result: unknown = 'pending';
    const asked = findEmbeddedSubtitleHit(input).then((value) => {
      result = value;
    });
    await jest.advanceTimersByTimeAsync(EMBEDDED_SCAN_RESPONSE_TIMEOUT_MS - 1);
    expect(result).toBe('pending');
    await jest.advanceTimersByTimeAsync(2);
    await asked;
    expect(result).toBeNull();
  });
});
