import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { toast } from 'sonner';
import { useStandaloneSubtitles } from '../useStandaloneSubtitles';
import {
  clearProofreadDraft,
  proofreadDraftKey,
} from '../../lib/proofreadDraft';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));
jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));
const mockTranslate = (key: string) => key;
const row = (text = 'Original') => ({
  id: '1',
  startEndTime: '00:00:01,000 --> 00:00:03,000',
  content: [text],
});
const config = {
  sourceSubtitlePath: '/source.srt',
  targetSubtitlePath: '/target.srt',
};
let invoke: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  window.ipc = undefined as any;
  for (const sourceSubtitlePath of [
    '/source.srt',
    '/other.srt',
    '/third.srt',
    '/empty.srt',
  ]) {
    for (const targetSubtitlePath of [undefined, '/target.srt']) {
      clearProofreadDraft(
        proofreadDraftKey({ sourceSubtitlePath, targetSubtitlePath }),
      );
    }
  }
  clearProofreadDraft(
    proofreadDraftKey({ ...config, proofreadDataFile: '/data.json' }),
  );
  invoke = jest.fn(async (channel: string, payload: any) => {
    if (channel === 'readSubtitleFile') return [row(payload.filePath)];
    if (channel === 'saveSubtitleFile') return { success: true };
    throw new Error(`Unexpected IPC ${channel}`);
  });
  window.ipc = { invoke } as any;
  URL.createObjectURL = jest.fn().mockReturnValue('blob:track');
  URL.revokeObjectURL = jest.fn();
});

test('draft disk read failure blocks load and retries without overwriting recovery data', async () => {
  let failed = true;
  window.ipc.proofreadDraft = {
    read: () =>
      failed
        ? { success: false, error: 'EACCES draft' }
        : { success: true, raw: null },
    write: jest.fn(() => ({ success: true, raw: null })),
  };
  const { result } = renderHook(() => useStandaloneSubtitles(config, true));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.loadError).toContain('EACCES draft');
  await act(async () => expect(await result.current.handleSave()).toBe(false));
  expect(window.ipc.proofreadDraft.write).not.toHaveBeenCalled();
  failed = false;
  await act(async () => result.current.retryLoad());
  expect(result.current.loadError).toBe('');
});

test('draft deletion failure keeps the editor dirty and explicit save can retry', async () => {
  let failed = true;
  window.ipc.proofreadDraft = {
    read: () => ({ success: true, raw: null }),
    write: (_key, raw) =>
      raw === null && failed
        ? { success: false, error: 'ENOSPC draft' }
        : { success: true, raw: null },
  };
  const { result } = renderHook(() => useStandaloneSubtitles(config, true));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'Keep last edit'),
  );
  await act(async () => expect(await result.current.handleSave()).toBe(false));
  expect(result.current.isDirty).toBe(true);
  expect(result.current.saveError).toContain('ENOSPC draft');
  failed = false;
  await act(async () => expect(await result.current.handleSave()).toBe(true));
  expect(result.current.isDirty).toBe(false);
});

test.each(['targetSubtitlePath', 'finalTargetSubtitlePath'])(
  'overlapping source and %s cannot load or overwrite the source',
  async (key) => {
    const { result } = renderHook(() =>
      useStandaloneSubtitles(
        {
          ...config,
          [key]: config.sourceSubtitlePath,
        },
        true,
      ),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toContain('proofreadImportState.sameFile');
    await act(async () =>
      expect(await result.current.handleSave()).toBe(false),
    );
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'saveSubtitleFile'),
    ).toBe(false);
  },
);

test('read failure stays blocked and retry loads the complete bilingual document', async () => {
  const normal = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((channel, payload) => {
    if (
      failed &&
      channel === 'readSubtitleFile' &&
      payload.filePath === '/target.srt'
    )
      throw new Error('EACCES target');
    return normal(channel, payload);
  });
  const { result } = renderHook(() =>
    useStandaloneSubtitles({ ...config }, true),
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.loadError).toContain('EACCES target');
  expect(result.current.mergedSubtitles).toEqual([]);
  await act(async () => expect(await result.current.handleSave()).toBe(false));
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'saveSubtitleFile'),
  ).toBe(false);
  failed = false;
  await act(async () => result.current.retryLoad());
  expect(result.current.loadError).toBe('');
  expect(result.current.mergedSubtitles[0]).toMatchObject({
    sourceContent: '/source.srt',
    targetContent: '/target.srt',
  });
});

test('a configured sidecar is authoritative, including empty cues, and never silently falls back', async () => {
  const normal = invoke.getMockImplementation()!;
  let sidecar: any = { subtitles: [], speakers: [] };
  invoke.mockImplementation((channel, payload) =>
    channel === 'readProofreadDataFile'
      ? Promise.resolve(sidecar)
      : normal(channel, payload),
  );
  const { result } = renderHook(() =>
    useStandaloneSubtitles(
      { ...config, proofreadDataFile: '/data.json' },
      true,
    ),
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.mergedSubtitles).toEqual([]);
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'readSubtitleFile'),
  ).toBe(false);
  sidecar = undefined;
  await act(async () => result.current.retryLoad());
  expect(result.current.loadError).not.toBe('');
  await act(async () => expect(await result.current.handleSave()).toBe(false));
});

test('switching documents rejects late reads, clears old media and does not copy dirty drafts', async () => {
  let release!: (rows: ReturnType<typeof row>[]) => void;
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'readSubtitleFile' && payload.filePath === '/source.srt'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(channel, payload),
  );
  const { result, rerender } = renderHook(
    ({ source, video }) =>
      useStandaloneSubtitles(
        { sourceSubtitlePath: source, videoPath: video },
        true,
      ),
    { initialProps: { source: '/source.srt', video: '/old.mp4' } },
  );
  rerender({ source: '/other.srt', video: '' });
  await waitFor(() =>
    expect(result.current.mergedSubtitles[0]?.sourceContent).toBe('/other.srt'),
  );
  await act(async () => release([row('Late original')]));
  expect(result.current.mergedSubtitles[0].sourceContent).toBe('/other.srt');
  expect(result.current.videoPath).toBe('');
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'Dirty other'),
  );
  rerender({ source: '/third.srt', video: '' });
  await waitFor(() =>
    expect(result.current.mergedSubtitles[0]?.sourceContent).toBe('/third.srt'),
  );
  expect(
    localStorage.getItem(
      proofreadDraftKey({ sourceSubtitlePath: '/third.srt' }),
    ),
  ).toBeNull();
});

test('a late save cannot mark a different document saved or discard its draft', async () => {
  let release!: (response: any) => void;
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'saveSubtitleFile'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(channel, payload),
  );
  const { result, rerender } = renderHook(
    ({ source }) =>
      useStandaloneSubtitles({ sourceSubtitlePath: source }, true),
    { initialProps: { source: '/source.srt' } },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'Old edit'),
  );
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.handleSave();
  });
  rerender({ source: '/other.srt' });
  await waitFor(() =>
    expect(result.current.mergedSubtitles[0]?.sourceContent).toBe('/other.srt'),
  );
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'New edit'),
  );
  await act(async () => {
    release({ success: true });
    expect(await saving).toBe(false);
  });
  expect(result.current.isDirty).toBe(true);
  expect(result.current.saveStatus).toBe('idle');
  expect(result.current.mergedSubtitles[0].sourceContent).toBe('New edit');
});

test.each([
  undefined,
  { error: 'Read failed' },
  [null],
  [{ ...row(), content: 'not an array' }],
  [{ ...row(), content: [1] }],
  [{ ...row(), startEndTime: 'invalid' }],
  [{ ...row(), startEndTime: '00:00:03,000 --> 00:00:01,000' }],
])('invalid IPC payload stays blocked: %j', async (payload) => {
  invoke.mockResolvedValue(payload);
  const { result } = renderHook(() => useStandaloneSubtitles(config, true));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.loadError).toBe('INVALID_SUBTITLE_RESPONSE');
  expect(result.current.mergedSubtitles).toEqual([]);
  await act(async () => expect(await result.current.handleSave()).toBe(false));
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('missing source blocks without IPC and closing cancels a pending load', async () => {
  const { result, rerender } = renderHook(
    ({ source, open }) =>
      useStandaloneSubtitles({ sourceSubtitlePath: source }, open),
    { initialProps: { source: '', open: true } },
  );
  await waitFor(() =>
    expect(result.current.loadError).toBe('SOURCE_SUBTITLE_REQUIRED'),
  );
  expect(invoke).not.toHaveBeenCalled();
  let release!: (response: any) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  rerender({ source: '/source.srt', open: true });
  expect(result.current.isLoading).toBe(true);
  rerender({ source: '/source.srt', open: false });
  await act(async () => release([row()]));
  expect(result.current.mergedSubtitles).toEqual([]);
  await act(async () => expect(await result.current.handleSave()).toBe(false));
});

test('equivalent config objects and explicit reload never discard dirty edits', async () => {
  const { result, rerender } = renderHook(() =>
    useStandaloneSubtitles({ ...config }, true),
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  const reads = invoke.mock.calls.length;
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'Keep dirty edit'),
  );
  for (let i = 0; i < 10; i++) rerender();
  await act(async () => result.current.retryLoad());
  expect(invoke).toHaveBeenCalledTimes(reads);
  expect(result.current.isDirty).toBe(true);
  expect(result.current.mergedSubtitles[0].sourceContent).toBe(
    'Keep dirty edit',
  );
});

test('StrictMode ignores its first load and loads an empty document without previous rows', async () => {
  const { result, rerender } = renderHook(
    ({ source }) =>
      useStandaloneSubtitles({ sourceSubtitlePath: source }, true),
    { initialProps: { source: '/source.srt' }, wrapper: StrictMode },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.mergedSubtitles).toHaveLength(1);
  expect(result.current.loadError).toBe('');
  invoke.mockResolvedValue([]);
  rerender({ source: '/empty.srt' });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.mergedSubtitles).toEqual([]);
  expect(result.current.loadError).toBe('');
});

test('late save rejection is isolated from a new save and cannot continue old outputs', async () => {
  const normal = invoke.getMockImplementation()!;
  let rejectOld!: (error: Error) => void;
  let finishNew!: (response: any) => void;
  invoke.mockImplementation((channel, payload) => {
    if (channel !== 'saveSubtitleFile') return normal(channel, payload);
    return payload.filePath === '/source.srt'
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : new Promise((resolve) => {
          finishNew = resolve;
        });
  });
  const { result, rerender } = renderHook(
    ({ source, target }) =>
      useStandaloneSubtitles(
        { sourceSubtitlePath: source, targetSubtitlePath: target },
        true,
      ),
    { initialProps: { source: '/source.srt', target: '/target.srt' } },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  let oldSave!: Promise<boolean>;
  act(() => {
    oldSave = result.current.handleSave();
  });
  rerender({ source: '/other.srt', target: '' });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'New edit'),
  );
  let newSave!: Promise<boolean>;
  act(() => {
    newSave = result.current.handleSave();
  });
  await act(async () => {
    rejectOld(new Error('Late disk failure'));
    expect(await oldSave).toBe(false);
  });
  expect(result.current.saveStatus).toBe('saving');
  expect(result.current.saveError).toBe('');
  expect(toast.error).not.toHaveBeenCalled();
  act(() => expect(result.current.handleSave()).toBe(newSave));
  await act(async () => {
    finishNew({ success: true });
    expect(await newSave).toBe(true);
  });
  expect(result.current.saveStatus).toBe('saved');
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'saveSubtitleFile')
      .map(([, payload]) => payload.filePath),
  ).toEqual(['/source.srt', '/other.srt']);
});

test('a stale successful save does not dispatch its remaining translation outputs', async () => {
  const normal = invoke.getMockImplementation()!;
  let release!: (response: any) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'saveSubtitleFile'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(channel, payload),
  );
  const { result, rerender } = renderHook(
    ({ source }) =>
      useStandaloneSubtitles({ ...config, sourceSubtitlePath: source }, true),
    { initialProps: { source: '/source.srt' } },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.handleSave();
  });
  rerender({ source: '/other.srt' });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await act(async () => {
    release({ success: true });
    expect(await saving).toBe(false);
  });
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'saveSubtitleFile'),
  ).toHaveLength(1);
});

test('duplicate timestamps preserve each translation and reserve exact matches before positional fallback', async () => {
  const later = '00:00:04,000 --> 00:00:06,000';
  const last = '00:00:07,000 --> 00:00:09,000';
  const sourceRows = [
    row('First'),
    row('Second'),
    { ...row('Later'), startEndTime: later },
  ];
  let targetRows = [
    row('One'),
    row('Two'),
    { ...row('Three'), startEndTime: last },
  ];
  invoke.mockImplementation(async (_channel, payload) =>
    payload.filePath === '/source.srt' ? sourceRows : targetRows,
  );
  const { result } = renderHook(() => useStandaloneSubtitles(config, true));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(
    result.current.mergedSubtitles.map((sub) => sub.targetContent),
  ).toEqual(['One', 'Two', 'Three']);
  targetRows = [{ ...row('Three'), startEndTime: later }, row('One')];
  await act(async () => result.current.retryLoad());
  expect(
    result.current.mergedSubtitles.map((sub) => sub.targetContent),
  ).toEqual(['One', '', 'Three']);
});

test.each([0, 1])(
  'extra translation rows cannot be lost when source has %i cues',
  async (count) => {
    invoke.mockImplementation(async (_channel, payload) =>
      payload.filePath === '/source.srt'
        ? Array.from({ length: count }, () => row())
        : [row('One'), row('Two')],
    );
    const { result } = renderHook(() => useStandaloneSubtitles(config, true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBe('proofreadLoad.extraTranslations');
    expect(result.current.mergedSubtitles).toEqual([]);
    await act(async () =>
      expect(await result.current.handleSave()).toBe(false),
    );
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'saveSubtitleFile'),
    ).toBe(false);
  },
);

describe('player preview', () => {
  type PreviewResult = {
    current: { subtitleTracksForPlayer: Array<{ src: string }> };
  };
  const languages = { sourceLanguage: 'en', targetLanguage: 'fr' };
  const previewBlobs = new Map<string, Blob>();
  const readBlob = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  // VTT text of every published track, in player order (source, then translation)
  const vttOf = (result: PreviewResult) =>
    Promise.all(
      result.current.subtitleTracksForPlayer.map((track) =>
        readBlob(previewBlobs.get(track.src)!),
      ),
    );
  const createdUrls = () =>
    (URL.createObjectURL as jest.Mock).mock.calls.length;
  const sleep = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  beforeEach(() => {
    let counter = 0;
    previewBlobs.clear();
    URL.createObjectURL = jest.fn((blob: Blob | MediaSource) => {
      const url = `blob:preview-${++counter}`;
      previewBlobs.set(url, blob as Blob);
      return url;
    });
  });

  test('is built from the loaded document even when no language is known', async () => {
    const { result } = renderHook(() => useStandaloneSubtitles(config, true));
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );

    expect(result.current.subtitleTracksForPlayer).toMatchObject([
      { kind: 'subtitles', srcLang: 'und', label: 'source', default: false },
      { kind: 'subtitles', srcLang: 'und', label: 'target', default: true },
    ]);
    const [source, target] = await vttOf(result);
    expect(source).toContain('/source.srt');
    expect(target).toContain('/target.srt');
  });

  test('previews a sidecar document from its own rows instead of the SRT on disk', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'readProofreadDataFile'
        ? Promise.resolve({
            subtitles: [
              {
                ...row('Sidecar source'),
                sourceContent: 'Sidecar source',
                targetContent: 'Sidecar translation',
                startTimeInSeconds: 1,
                endTimeInSeconds: 3,
              },
            ],
            speakers: [],
          })
        : normal(channel, payload),
    );
    const { result } = renderHook(() =>
      useStandaloneSubtitles(
        { ...config, ...languages, proofreadDataFile: '/data.json' },
        true,
      ),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );

    const [source, target] = await vttOf(result);
    expect(source).toContain('Sidecar source');
    expect(target).toContain('Sidecar translation');
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain(
      'getSubtitleAsVtt',
    );
  });

  test('follows edits to either column after a short pause', async () => {
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );
    const before = result.current.subtitleTracksForPlayer;
    expect(before).toMatchObject([
      { srcLang: 'en', label: '(en)', default: false },
      { srcLang: 'fr', label: '(fr)', default: true },
    ]);

    act(() =>
      result.current.handleSubtitleChange(0, 'sourceContent', 'Fixed typo'),
    );
    act(() =>
      result.current.handleSubtitleChange(0, 'targetContent', 'Faute corrigee'),
    );

    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Fixed typo'),
    );
    expect(await vttOf(result)).toEqual([
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFixed typo\n\n',
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFaute corrigee\n\n',
    ]);
    before.forEach((track) =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(track.src),
    );
  });

  test('publishes only the final text of a burst of edits', async () => {
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );
    const created = createdUrls();

    for (const text of ['F', 'Fi', 'Fin', 'Final']) {
      act(() => result.current.handleSubtitleChange(0, 'sourceContent', text));
    }

    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Final'),
    );
    expect(createdUrls()).toBe(created + 2);
  });

  test('follows undo and redo', async () => {
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );

    act(() =>
      result.current.handleSubtitleChange(0, 'sourceContent', 'Edited'),
    );
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Edited'),
    );
    act(() => result.current.handleUndo());
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('/source.srt'),
    );
    act(() => result.current.handleRedo());
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Edited'),
    );
  });

  test('follows time changes and deleted cues', async () => {
    invoke.mockImplementation(async (_channel, payload) => [
      row(`${payload.filePath} one`),
      {
        ...row(`${payload.filePath} two`),
        id: '2',
        startEndTime: '00:00:05,000 --> 00:00:06,000',
      },
    ]);
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );

    act(() => expect(result.current.handleTimeChange(0, 1.5, 2.5)).toBeNull());
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain(
        '00:00:01.500 --> 00:00:02.500',
      ),
    );
    act(() => result.current.handleDeleteSubtitle(0));
    await waitFor(async () => {
      const [source] = await vttOf(result);
      expect(source).not.toContain('one');
      expect(source).toContain('two');
    });
  });

  test('does not rebuild for changes that cannot affect what is shown', async () => {
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );
    const tracks = result.current.subtitleTracksForPlayer;
    const created = createdUrls();

    act(() => result.current.handleSetCueSpeakers(0, [1], 1));
    await sleep(400);
    expect(result.current.mergedSubtitles[0].speakerIds).toEqual([1]);
    expect(createdUrls()).toBe(created);
    expect(result.current.subtitleTracksForPlayer).toBe(tracks);

    act(() =>
      result.current.handleSubtitleChange(0, 'sourceContent', 'Now visible'),
    );
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Now visible'),
    );
    expect(createdUrls()).toBe(created + 2);
  });

  test('releases its URLs on unmount and cancels a pending rebuild', async () => {
    const { result, unmount } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(2),
    );
    const urls = result.current.subtitleTracksForPlayer.map(
      (track) => track.src,
    );
    act(() =>
      result.current.handleSubtitleChange(0, 'sourceContent', 'Pending edit'),
    );

    unmount();
    urls.forEach((url) =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url),
    );
    const created = createdUrls();
    await sleep(400);
    expect(createdUrls()).toBe(created);
  });

  test('drops the previous document tracks while another document loads', async () => {
    const { result, rerender } = renderHook(
      ({ source }) =>
        useStandaloneSubtitles(
          { sourceSubtitlePath: source, sourceLanguage: 'en' },
          true,
        ),
      { initialProps: { source: '/source.srt' } },
    );
    await waitFor(() =>
      expect(result.current.subtitleTracksForPlayer).toHaveLength(1),
    );
    const previous = result.current.subtitleTracksForPlayer[0].src;

    rerender({ source: '/other.srt' });
    expect(result.current.subtitleTracksForPlayer).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previous);

    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('/other.srt'),
    );
  });

  test('a preview failure never blocks editing and recovers on the next change', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    (URL.createObjectURL as jest.Mock).mockImplementationOnce(() => {
      throw new Error('blob unavailable');
    });
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('player preview'),
        expect.any(Error),
      ),
    );
    expect(result.current.loadError).toBe('');
    expect(result.current.subtitleTracksForPlayer).toEqual([]);

    act(() =>
      result.current.handleSubtitleChange(0, 'sourceContent', 'Still editable'),
    );
    expect(result.current.mergedSubtitles[0].sourceContent).toBe(
      'Still editable',
    );
    await waitFor(async () =>
      expect((await vttOf(result))[0]).toContain('Still editable'),
    );
    log.mockRestore();
  });

  test('does not leak the first URL when the second track cannot be created', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const create = URL.createObjectURL as jest.Mock;
    create
      .mockImplementationOnce(create.getMockImplementation()!)
      .mockImplementationOnce(() => {
        throw new Error('second track failed');
      });
    const { result } = renderHook(() =>
      useStandaloneSubtitles({ ...config, ...languages }, true),
    );
    await waitFor(() => expect(log).toHaveBeenCalled());

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(result.current.subtitleTracksForPlayer).toEqual([]);
    log.mockRestore();
  });
});
