import {
  initializeWorkItemStore,
  getWorkItems,
  renameWorkItem,
  flushWorkItemStore,
} from '../../../main/helpers/workItemStore';
import {
  startProcessingHistory,
  updateProcessingHistory,
  trackToolOperation,
} from '../../../main/helpers/processingHistory';
import { store } from '../../../main/helpers/store';
import { getWorkItemTarget, getWorkItemStatus } from '../workItemUtils';

jest.mock('../../../main/helpers/store', () => ({
  store: { get: jest.fn(), set: jest.fn() },
}));
let disk: Record<string, any>;
beforeEach(() => {
  disk = { workItemsMigrationVersion: 1, workItems: [] };
  (store.get as jest.Mock).mockImplementation((key) =>
    structuredClone(disk[key]),
  );
  (store.set as jest.Mock).mockImplementation((key, value) => {
    disk[key] = structuredClone(value);
  });
  initializeWorkItemStore();
});

test('tool results survive restart and reopen a result record rather than a subtitle task', async () => {
  await trackToolOperation('subtitle-converter', ['/one.srt'], {}, () => ({
    success: true,
    outputPath: '/one.vtt',
  }));
  const [item] = getWorkItems();
  expect(item.artifacts?.[0].path).toBe('/one.vtt');
  expect(disk.workItems[0].status).toBe('done');
  initializeWorkItemStore();
  expect(getWorkItemStatus(getWorkItems()[0])).toBe('done');
  expect(getWorkItemTarget(item, 'zh')).toContain(
    '/processing-result?workItem=',
  );
});

test('partial failures retain successful artifacts and an explanation', async () => {
  await trackToolOperation(
    'subtitle-converter',
    ['/a.srt', '/b.srt'],
    {},
    () => [
      { success: true, outputPath: '/a.vtt' },
      { success: false, error: 'Unreadable b.srt' },
    ],
  );
  const [item] = getWorkItems();
  expect(item.status).toBe('error');
  expect(item.processing?.error).toBe('Unreadable b.srt');
  expect(item.artifacts).toEqual([{ kind: 'vtt', path: '/a.vtt' }]);
});

test('unfinished compose records become interrupted after restart; updates preserve renames', () => {
  const id = startProcessingHistory({
    type: 'compose',
    inputPaths: ['/movie.mp4'],
    status: 'waiting',
  });
  renameWorkItem(id, 'My export');
  updateProcessingHistory(id, 'running');
  initializeWorkItemStore();
  expect(getWorkItems()[0].status).toBe('interrupted');
  expect(getWorkItems()[0].name).toBe('My export');
});

test('a failed initial history write does not start processing', async () => {
  const run = jest.fn();
  (store.set as jest.Mock).mockImplementation(() => {
    throw new Error('ENOSPC');
  });
  await expect(
    trackToolOperation('video-compressor', ['/a.mp4'], {}, run),
  ).rejects.toThrow('ENOSPC');
  expect(run).not.toHaveBeenCalled();
});

test('a failed final history write preserves usable outputs and retries persistence', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const persist = (store.set as jest.Mock).getMockImplementation();
  try {
    const result = await trackToolOperation(
      'subtitle-converter',
      ['/one.srt'],
      {},
      () => {
        (store.set as jest.Mock).mockImplementationOnce(() => {
          throw new Error('ENOSPC');
        });
        return { success: true, outputPath: '/one.vtt' };
      },
    );
    expect(result).toEqual({ success: true, outputPath: '/one.vtt' });
    expect(disk.workItems[0].status).toBe('running');
    expect(getWorkItems()[0].artifacts?.[0].path).toBe('/one.vtt');
    flushWorkItemStore();
    expect(disk.workItems[0].status).toBe('done');
    initializeWorkItemStore();
    expect(getWorkItems()[0].artifacts?.[0].path).toBe('/one.vtt');
  } finally {
    (store.set as jest.Mock).mockImplementation(persist);
    log.mockRestore();
  }
});
