import React, { StrictMode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import ProofreadImport from '../proofread/ProofreadImport';
import ProofreadFileList from '../proofread/ProofreadFileList';
import type { PendingFile } from '../../lib/proofreadUtils';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel: string) => {
    if (channel === 'selectFiles')
      return { canceled: false, filePaths: ['/new.fr.srt'] };
    if (channel === 'selectDirectory')
      return { canceled: false, directoryPath: '/folder' };
    if (channel === 'smartScanDirectory')
      return {
        success: true,
        data: { videos: [], subtitles: ['/new.fr.srt'] },
      };
    if (channel === 'matchSubtitleFiles')
      return {
        success: true,
        data: [
          { baseName: 'New', source: '/new.fr.srt', sourceLanguage: 'fr' },
        ],
      };
    if (channel === 'checkFileExists') return { exists: true };
    if (channel === 'detectLanguage')
      return { success: true, data: { code: 'fr' } };
    if (channel === 'getUserConfig')
      return { sourceLanguage: 'en', targetLanguage: 'fr' };
    if (channel === 'detectSubtitles')
      return { success: true, data: { detectedSubtitles: [] } };
    throw new Error(channel);
  });
  window.ipc = { invoke } as any;
});
const file = (id: string): PendingFile => ({
  id,
  fileName: id,
  selectedSource: `/${id}.srt`,
  proofreadDataFile: `/${id}.json`,
  detectedSubtitles: [],
  status: 'pending',
});
const props = () => ({
  files: [file('one'), file('two')],
  savedTaskId: 'task',
  taskName: 'Task',
  importType: 'subtitle' as const,
  onTaskNameChange: jest.fn(),
  onStartProofread: jest.fn(),
  onUpdateFile: jest.fn(),
  onRemoveFile: jest.fn(),
  onAddFiles: jest.fn(),
  onSaveTask: jest.fn(),
  saveStatus: 'idle' as const,
  isDirty: false,
  onReset: jest.fn(),
});

test.each(['importSubtitles', 'importVideos', 'importFolder'])(
  'import failure retains selected paths for retry: %s',
  async (button) => {
    const complete = jest.fn();
    const normal = invoke.getMockImplementation()!;
    let failed = true;
    invoke.mockImplementation((channel, payload) =>
      ['detectSubtitles', 'smartScanDirectory'].includes(channel) && failed
        ? Promise.resolve({ success: false, error: 'Permission denied' })
        : normal(channel, payload),
    );
    render(
      <StrictMode>
        <ProofreadImport onImportComplete={complete} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Permission denied'),
    );
    expect(complete).not.toHaveBeenCalled();
    failed = false;
    fireEvent.click(
      screen.getByRole('button', { name: 'proofreadImportState.retry' }),
    );
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const picker =
      button === 'importFolder' ? 'selectDirectory' : 'selectFiles';
    expect(
      invoke.mock.calls.filter(([channel]) => channel === picker),
    ).toHaveLength(1);
  },
);

test('a canceled picker is quiet and imports never commit after unmount', async () => {
  const complete = jest.fn();
  invoke.mockResolvedValueOnce({ canceled: true });
  const view = render(<ProofreadImport onImportComplete={complete} />);
  fireEvent.click(screen.getByRole('button', { name: 'importSubtitles' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'importSubtitles' }),
    ).toBeEnabled(),
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  let release!: (value: any) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'importSubtitles' }));
  view.unmount();
  await act(async () => release({ canceled: false, filePaths: ['/late.srt'] }));
  expect(complete).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(2);
});

test('append failure is atomic, retry is single-flight and a non-English source is never its own translation', async () => {
  const value = props();
  const normal = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((channel, payload) =>
    channel === 'detectLanguage' && failed
      ? Promise.resolve({ success: false, error: 'Language read failure' })
      : normal(channel, payload),
  );
  render(<ProofreadFileList {...value} />);
  fireEvent.click(screen.getByRole('button', { name: 'appendSubtitles' }));
  fireEvent.click(screen.getByRole('button', { name: 'appendSubtitles' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Language read failure',
    ),
  );
  expect(value.onAddFiles).not.toHaveBeenCalled();
  failed = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'proofreadImportState.retry' }),
  );
  await waitFor(() => expect(value.onAddFiles).toHaveBeenCalledTimes(1));
  expect(value.onAddFiles.mock.calls[0][0][0]).toMatchObject({
    selectedSource: '/new.fr.srt',
    selectedTarget: undefined,
  });
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'selectFiles'),
  ).toHaveLength(1);
});

test.each([false, true])(
  'manual selection uses file identity after removal (selected file deleted: %s)',
  async (deleted) => {
    const value = props();
    const normal = invoke.getMockImplementation()!;
    let release!: (value: any) => void;
    invoke.mockImplementation((channel, payload) =>
      channel === 'detectLanguage'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : normal(channel, payload),
    );
    const view = render(<ProofreadFileList {...value} />);
    fireEvent.click(screen.getAllByTitle('uploadSubtitle')[2]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('detectLanguage', {
        filePath: '/new.fr.srt',
      }),
    );
    view.rerender(
      <ProofreadFileList {...value} files={[file(deleted ? 'one' : 'two')]} />,
    );
    await act(async () => release({ success: true, data: { code: 'fr' } }));
    if (deleted) expect(value.onUpdateFile).not.toHaveBeenCalled();
    else {
      expect(value.onUpdateFile).not.toHaveBeenCalled();
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'proofreadImportState.replaceConfirm',
        }),
      );
      expect(value.onUpdateFile).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          selectedSource: '/new.fr.srt',
          proofreadDataFile: undefined,
        }),
      );
    }
  },
);

test('failed manual selection leaves the old sidecar until a successful retry', async () => {
  const value = props();
  const normal = invoke.getMockImplementation()!;
  let exists = false;
  invoke.mockImplementation((channel, payload) =>
    channel === 'checkFileExists'
      ? Promise.resolve({ exists })
      : normal(channel, payload),
  );
  render(<ProofreadFileList {...value} />);
  fireEvent.click(screen.getAllByTitle('uploadSubtitle')[1]);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('File not found'),
  );
  expect(value.onUpdateFile).not.toHaveBeenCalled();
  exists = true;
  fireEvent.click(
    screen.getByRole('button', { name: 'proofreadImportState.retry' }),
  );
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'proofreadImportState.replaceConfirm',
    }),
  );
  await waitFor(() =>
    expect(value.onUpdateFile).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        selectedTarget: '/new.fr.srt',
        proofreadDataFile: undefined,
      }),
    ),
  );
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'selectFiles'),
  ).toHaveLength(1);
});

test('replacement requires confirmation, clears old export destinations and ignores a deleted item', async () => {
  const value = props();
  value.files[0] = {
    ...file('one'),
    status: 'completed',
    finalTargetPath: '/old-final.srt',
    translateContent: 'both',
  };
  const view = render(<ProofreadFileList {...value} />);
  fireEvent.click(screen.getAllByTitle('uploadSubtitle')[1]);
  await screen.findByRole('alertdialog');
  expect(value.onUpdateFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  expect(value.onUpdateFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByTitle('uploadSubtitle')[1]);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'proofreadImportState.replaceConfirm',
    }),
  );
  expect(value.onUpdateFile).toHaveBeenCalledWith(
    0,
    expect.objectContaining({
      selectedTarget: '/new.fr.srt',
      proofreadDataFile: undefined,
      finalTargetPath: undefined,
      translateContent: undefined,
      status: 'pending',
    }),
  );
  value.onUpdateFile.mockClear();
  fireEvent.click(screen.getAllByTitle('uploadSubtitle')[1]);
  await screen.findByRole('alertdialog');
  view.rerender(<ProofreadFileList {...value} files={[file('two')]} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'proofreadImportState.replaceConfirm' }),
  );
  expect(value.onUpdateFile).not.toHaveBeenCalled();
});

test.each(['source', 'target'])(
  'manual %s cannot reuse the other subtitle file',
  async (type) => {
    const value = props();
    value.files[0].selectedTarget = '/target.srt';
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) =>
      channel === 'selectFiles'
        ? Promise.resolve({
            filePaths: [type === 'source' ? '/target.srt' : '/one.srt'],
          })
        : normal(channel, payload),
    );
    render(<ProofreadFileList {...value} />);
    fireEvent.click(
      screen.getAllByTitle('uploadSubtitle')[type === 'source' ? 0 : 1],
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'proofreadImportState.sameFile',
      ),
    );
    expect(value.onUpdateFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  },
);

test('folder import retains a standalone non-English subtitle instead of silently dropping it', async () => {
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'matchSubtitleFiles'
      ? Promise.resolve({
          success: true,
          data: [
            { baseName: 'New', target: '/new.fr.srt', targetLanguage: 'fr' },
          ],
        })
      : normal(channel, payload),
  );
  const complete = jest.fn();
  render(<ProofreadImport onImportComplete={complete} />);
  fireEvent.click(screen.getByRole('button', { name: 'importFolder' }));
  await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  expect(complete.mock.calls[0][0][0]).toMatchObject({
    selectedSource: '/new.fr.srt',
    sourceLanguage: 'fr',
    selectedTarget: undefined,
  });
});

test.each(['appendSubtitles', 'importFolder'])(
  '%s keeps every selected subtitle, including unpaired language variants',
  async (button) => {
    const paths = ['/movie.en.srt', '/movie.fr.srt', '/movie.ja.srt'];
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel, payload) => {
      if (channel === 'selectFiles')
        return Promise.resolve({ filePaths: paths });
      if (channel === 'smartScanDirectory')
        return Promise.resolve({
          success: true,
          data: { videos: [], subtitles: paths },
        });
      if (channel === 'matchSubtitleFiles')
        return Promise.resolve({
          success: true,
          data: [{ baseName: 'movie', source: paths[0], target: paths[1] }],
        });
      return normal(channel, payload);
    });
    const value = props();
    const complete = jest.fn();
    render(
      button === 'appendSubtitles' ? (
        <ProofreadFileList {...value} />
      ) : (
        <ProofreadImport onImportComplete={complete} />
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: button }));
    const commit = button === 'appendSubtitles' ? value.onAddFiles : complete;
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const imported = commit.mock.calls[0][0] as PendingFile[];
    expect(
      new Set(
        imported.flatMap((item) =>
          [item.selectedSource, item.selectedTarget].filter(Boolean),
        ),
      ),
    ).toEqual(new Set(paths));
    if (button === 'appendSubtitles') expect(imported).toHaveLength(3);
    else expect(imported).toHaveLength(2);
  },
);
