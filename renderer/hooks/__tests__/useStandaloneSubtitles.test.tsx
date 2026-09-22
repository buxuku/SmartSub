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
    if (channel === 'getSubtitleAsVtt') return { content: 'WEBVTT\n\n' };
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

test('VTT failures are non-destructive and retry never replaces edited subtitles', async () => {
  const normal = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((channel, payload) =>
    channel === 'getSubtitleAsVtt' && failed
      ? Promise.resolve({ error: 'Preview unavailable' })
      : normal(channel, payload),
  );
  const { result, unmount } = renderHook(() =>
    useStandaloneSubtitles(
      { sourceSubtitlePath: '/source.srt', sourceLanguage: 'en' },
      true,
    ),
  );
  await waitFor(() =>
    expect(result.current.trackError).toContain('Preview unavailable'),
  );
  expect(result.current.loadError).toBe('');
  act(() =>
    result.current.handleSubtitleChange(0, 'sourceContent', 'Keep this edit'),
  );
  failed = false;
  await act(async () => result.current.retryTracks());
  expect(result.current.trackError).toBe('');
  expect(result.current.mergedSubtitles[0].sourceContent).toBe(
    'Keep this edit',
  );
  expect(result.current.subtitleTracksForPlayer).toHaveLength(1);
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:track');
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

test('late preview URLs are released after unmount without reading another track', async () => {
  const normal = invoke.getMockImplementation()!;
  let release!: (response: any) => void;
  invoke.mockImplementation((channel, payload) =>
    channel === 'getSubtitleAsVtt'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(channel, payload),
  );
  const { result, unmount } = renderHook(() =>
    useStandaloneSubtitles(
      { ...config, sourceLanguage: 'en', targetLanguage: 'fr' },
      true,
    ),
  );
  await waitFor(() => expect(result.current.tracksLoading).toBe(true));
  unmount();
  await act(async () => release({ content: 'WEBVTT\n\n' }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:track');
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'getSubtitleAsVtt'),
  ).toHaveLength(1);
});

test('out-of-order preview retries release stale URLs and retain the latest result', async () => {
  const normal = invoke.getMockImplementation()!;
  const pending: Array<(response: any) => void> = [];
  invoke.mockImplementation((channel, payload) =>
    channel === 'getSubtitleAsVtt'
      ? new Promise((resolve) => {
          pending.push(resolve);
        })
      : normal(channel, payload),
  );
  let urlIndex = 0;
  URL.createObjectURL = jest.fn(() => `blob:${++urlIndex}`);
  const { result, unmount } = renderHook(() =>
    useStandaloneSubtitles(
      { sourceSubtitlePath: '/source.srt', sourceLanguage: 'en' },
      true,
    ),
  );
  await waitFor(() => expect(pending).toHaveLength(1));
  let retry!: Promise<void>;
  act(() => {
    retry = result.current.retryTracks();
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1]({ content: 'WEBVTT\n\nNew' });
    await retry;
  });
  await act(async () => pending[0]({ content: 'WEBVTT\n\nOld' }));
  expect(result.current.subtitleTracksForPlayer[0].src).toBe('blob:1');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:1');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
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
