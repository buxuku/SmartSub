import type { ProofreadDraft } from '../proofreadDraft';

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
});
afterEach(() => jest.restoreAllMocks());

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
