import type { ProofreadDraft } from '../proofreadDraft';
import { emptyQualityReview } from '../../../types/qualityReview';

const load = (): typeof import('../proofreadDraft') =>
  require('../proofreadDraft');
const draft = (count = 10000): ProofreadDraft => ({
  subtitles: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    content: [`Original ${index}`],
    sourceContent: `Original ${index}`,
    startEndTime: '00:00:00,000 --> 00:00:01,000',
    startTimeInSeconds: index * 2,
    endTimeInSeconds: index * 2 + 1,
  })),
  speakers: [],
  embedSpeakerNames: false,
  savedAt: Date.now(),
});
const key = 'smartsub_proofread_draft_v1:test';
beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  window.ipc = undefined as any;
});
afterEach(() => jest.restoreAllMocks());

test('invalid optional review metadata never hides recoverable subtitle text', () => {
  const value = draft(2);
  localStorage.setItem(
    key,
    JSON.stringify({ ...value, qualityReview: { version: 99 } }),
  );
  expect(load().readProofreadDraft(key)?.subtitles).toEqual(value.subtitles);
});

test('oversized legacy review catalogs recover subtitles and insertion drafts', () => {
  const value = draft(1);
  const review = emptyQualityReview();
  review.catalog = Array.from({ length: 60000 }, (_, i) => ({
    key: String(i),
    evidence: 'same',
    kind: 'translation',
    start: i,
    end: i + 1,
    indices: [i],
    more: false,
    priority: 0,
    detail: { reason: 'translation' },
  }));
  review.insertionDrafts = {
    gap: { start: '5', end: '6', source: 'Pending text', target: '' },
  };
  let raw = JSON.stringify({ ...value, qualityReview: review });
  window.ipc = {
    proofreadDraft: {
      read: () => ({ success: true, raw }),
      write: (_key, value) => {
        raw = value;
        return { success: true };
      },
    },
  } as any;
  const recovered = load().readProofreadDraft(key);
  expect(recovered?.subtitles).toEqual(value.subtitles);
  expect(recovered?.qualityReview?.insertionDrafts).toEqual(
    review.insertionDrafts,
  );
  expect(recovered!.qualityReview!.catalog.length).toBeLessThanOrEqual(50000);
  expect(
    load().writeProofreadDraft(key, { ...value, qualityReview: review }),
  ).toBe(true);
  expect(JSON.parse(raw).qualityReview.catalog.length).toBeLessThanOrEqual(
    50000,
  );
});

test.each([0, 2, 128, 129, 10000])(
  '%i-cue drafts retain the legacy atomic format and recover',
  (count) => {
    const value = draft(count);
    expect(load().writeProofreadDraft(key, value)).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(value);
    jest.resetModules();
    expect(load().readProofreadDraft(key)).toEqual(value);
  },
);

test('10000-cue edits only reserialize the changed block and commit one storage value', () => {
  const value = draft();
  load().writeProofreadDraft(key, value);
  const stringify = jest.spyOn(JSON, 'stringify');
  const writes = jest.spyOn(Storage.prototype, 'setItem');
  const next = {
    ...value,
    subtitles: value.subtitles.map((row, index) =>
      index === 9999 ? { ...row, sourceContent: 'Last "character"\n\\' } : row,
    ),
  };
  expect(load().writeProofreadDraft(key, next)).toBe(true);
  const arrays = stringify.mock.calls
    .map(([value]) => value)
    .filter((value) => Array.isArray(value) && value.length);
  expect(arrays).toHaveLength(1);
  expect(arrays[0]).toHaveLength(16);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(1);
  jest.resetModules();
  expect(load().readProofreadDraft(key)).toEqual(next);
  load().clearProofreadDraft(key);
  expect(localStorage.length).toBe(0);
});

test('failed writes preserve old disk state and latest memory for retry', () => {
  const value = draft();
  load().writeProofreadDraft(key, value);
  const old = localStorage.getItem(key);
  const next = {
    ...value,
    subtitles: value.subtitles.map((row, index) =>
      index === 0 ? { ...row, sourceContent: 'Pending' } : row,
    ),
  };
  const spy = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Quota');
    });
  expect(load().writeProofreadDraft(key, next)).toBe(false);
  expect(load().readProofreadDraft(key)).toEqual(next);
  expect(localStorage.getItem(key)).toBe(old);
  spy.mockRestore();
  expect(load().writeProofreadDraft(key, next)).toBe(true);
  jest.resetModules();
  expect(load().readProofreadDraft(key)).toEqual(next);
});

test('structural edits and multiple writers leave one complete recoverable snapshot', () => {
  const first = load();
  const value = draft(300);
  first.writeProofreadDraft(key, value);
  jest.resetModules();
  const second = load();
  const next = {
    ...second.readProofreadDraft(key)!,
    subtitles: value.subtitles.slice(1),
  };
  second.writeProofreadDraft(key, next);
  first.writeProofreadDraft(key, { ...value, subtitles: [] });
  second.writeProofreadDraft(key, {
    ...next,
    subtitles: next.subtitles.slice(0, 2),
  });
  jest.resetModules();
  expect(load().readProofreadDraft(key)?.subtitles).toEqual(
    next.subtitles.slice(0, 2),
  );
  expect(localStorage.length).toBe(1);
});

test('malformed/null stored drafts do not recover as valid data and can be discarded', () => {
  for (const raw of [
    'null',
    '{',
    '{"subtitles":[{}],"speakers":[],"embedSpeakerNames":false,"savedAt":1}',
  ]) {
    localStorage.setItem(key, raw);
    expect(load().readProofreadDraft(key)).toBeNull();
    load().clearProofreadDraft(key);
    expect(localStorage.length).toBe(0);
  }
});

test('native snapshots survive loss of browser storage and tombstones prevent stale recovery', () => {
  const disk = new Map<string, string>();
  window.ipc = {
    proofreadDraft: {
      read: (key: string) => ({ success: true, raw: disk.get(key) ?? null }),
      write: (key: string, raw: string | null) => {
        disk.set(key, raw ?? 'null');
        return { success: true, raw: null };
      },
    },
  } as any;
  const value = draft(2);
  localStorage.setItem(key, JSON.stringify(value));
  expect(load().readProofreadDraft(key)).toEqual(value); // legacy migration
  const next = {
    ...value,
    subtitles: [{ ...value.subtitles[0], sourceContent: 'Latest character' }],
  };
  expect(load().writeProofreadDraft(key, next)).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
  jest.resetModules();
  expect(load().readProofreadDraft(key)).toEqual(next);
  load().clearProofreadDraft(key);
  localStorage.setItem(key, JSON.stringify(value)); // simulate unflushed removal
  jest.resetModules();
  expect(load().readProofreadDraft(key)).toBeNull();
});

test('native read/write/clear failures cannot claim durable success or discard pending work', () => {
  window.ipc = {
    proofreadDraft: {
      read: () => ({ success: false, error: 'EACCES' }),
      write: () => ({ success: false, error: 'ENOSPC' }),
    },
  } as any;
  expect(() => load().readProofreadDraft(key)).toThrow('EACCES');
  const value = draft(2);
  expect(load().writeProofreadDraft(key, value)).toBe(false);
  expect(load().readProofreadDraft(key)).toEqual(value);
  expect(() => load().clearProofreadDraft(key)).toThrow('ENOSPC');
  expect(load().readProofreadDraft(key)).toEqual(value);
  expect(localStorage.getItem(key)).toBeNull();
});
