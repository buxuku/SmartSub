import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useStandaloneSubtitles } from '../renderer/hooks/useStandaloneSubtitles';
import { emptyQualityReview, type QualityIssue } from '../types/qualityReview';

async function main() {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: { en: { home: {} } }, initImmediate: false });
  const files = new Map<string, string>();
  let saved = emptyQualityReview(),
    subtitleWrites = 0,
    fail = false,
    readFail = false,
    hold = false,
    holdRead = false,
    releaseRead: () => void,
    release: () => void;
  const config = { sourceSubtitlePath: '/tmp/quality-state-source.srt' };
  (globalThis as any).window = {
    localStorage: {
      getItem: (k) => files.get(k) ?? null,
      setItem: (k, v) => files.set(k, v),
      removeItem: (k) => files.delete(k),
    },
    ipc: {
      invoke: async (channel, payload) => {
        if (channel === 'readSubtitleFile')
          return [
            {
              id: '1',
              startEndTime: '00:00:01,000 --> 00:00:03,000',
              content: ['Original'],
            },
          ];
        if (channel === 'qualityReview:read') {
          if (holdRead)
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          return readFail
            ? { success: false, error: 'unreadable progress' }
            : { success: true, data: structuredClone(saved) };
        }
        if (channel === 'qualityReview:save') {
          if (hold) await new Promise<void>((r) => (release = r));
          if (fail) return { success: false, error: 'disk full' };
          saved = structuredClone(payload.state);
          return { success: true };
        }
        if (channel === 'saveSubtitleFile') {
          subtitleWrites++;
          return { success: true };
        }
        throw new Error(channel);
      },
    },
  };
  let hook: ReturnType<typeof useStandaloneSubtitles>;
  function Harness() {
    hook = useStandaloneSubtitles(config, true, true);
    return null;
  }
  let root;
  await act(async () => {
    root = create(<Harness />);
  });
  const first = {
    ...hook!.qualityReview,
    view: { ...hook!.qualityReview.view, mode: 'issues' as const },
  };
  await act(async () => hook!.updateQualityReview(first, true));
  assert.equal(hook!.isDirty, true);
  await act(async () => assert.equal(await hook!.handleSave(), true));
  assert.equal(subtitleWrites, 0, 'review-only save never rewrites subtitles');
  assert.equal(saved.view.mode, 'issues');
  await act(async () => hook!.handleUndo());
  assert.equal(hook!.qualityReview.view.mode, 'all');
  await act(async () => hook!.handleRedo());
  assert.equal(hook!.qualityReview.view.mode, 'issues');
  const confirmed = { evidence: 'same cue', status: 'confirmed' as const };
  await act(async () =>
    hook!.updateQualityReview(
      {
        ...hook!.qualityReview,
        decisions: { issue: confirmed },
      },
      true,
    ),
  );
  const insertionDrafts = {
    gap: { start: '5', end: '6', source: 'Keep this typed text', target: '' },
  };
  await act(async () =>
    hook!.updateQualityReview({ ...hook!.qualityReview, insertionDrafts }),
  );
  await act(async () => hook!.handleUndo());
  assert.deepEqual(
    hook!.qualityReview.insertionDrafts,
    insertionDrafts,
    'decision undo must preserve later insertion text',
  );
  assert.equal(hook!.qualityReview.decisions.issue, undefined);
  await act(async () => hook!.handleRedo());
  assert.deepEqual(hook!.qualityReview.insertionDrafts, insertionDrafts);
  assert.deepEqual(hook!.qualityReview.decisions.issue, confirmed);
  assert.deepEqual(
    JSON.parse(Array.from(files.values())[0]).qualityReview.insertionDrafts,
    insertionDrafts,
    'durable draft also retains text',
  );
  await act(async () =>
    hook!.updateQualityReview(
      {
        ...hook!.qualityReview,
        insertionDrafts: {
          gap: { start: '5', end: '6', source: 'Unsaved gap text', target: '' },
        },
        view: { ...hook!.qualityReview.view, more: true },
      },
      true,
    ),
  );
  fail = true;
  await act(async () => assert.equal(await hook!.handleSave(), false));
  assert.equal(hook!.isDirty, true);
  assert.equal(hook!.saveStatus, 'save_error');
  assert.ok(JSON.parse(Array.from(files.values())[0]).qualityReview.view.more);
  await act(async () => root.unmount());
  await act(async () => {
    root = create(<Harness />);
  });
  assert.ok(hook!.recoveryDraft);
  await act(async () => hook!.restoreDraft());
  assert.equal(hook!.qualityReview.view.more, true);
  assert.equal(
    hook!.qualityReview.insertionDrafts?.gap.source,
    'Unsaved gap text',
  );
  fail = false;
  hold = true;
  let saving;
  act(() => {
    saving = hook!.handleSave();
  });
  await act(async () =>
    hook!.updateQualityReview(
      {
        ...hook!.qualityReview,
        view: { ...hook!.qualityReview.view, kind: 'speech' },
      },
      true,
    ),
  );
  await act(async () => {
    release!();
    assert.equal(await saving, false);
  });
  assert.equal(hook!.isDirty, true);
  hold = false;
  await act(async () => assert.equal(await hook!.handleSave(), true));
  await act(async () =>
    assert.equal(hook!.insertSubtitle(3.1, 4, 'Inserted'), true),
  );
  assert.equal(hook!.mergedSubtitles.length, 2);
  await act(async () => hook!.handleUndo());
  assert.equal(hook!.mergedSubtitles.length, 1);
  await act(async () => hook!.handleRedo());
  assert.equal(hook!.mergedSubtitles.length, 2);
  await act(async () =>
    assert.equal(hook!.insertSubtitle(2, 4, 'Overlap'), false),
  );
  const gap: QualityIssue = {
    key: 'gap-insert',
    kind: 'speech',
    start: 5,
    end: 6,
    evidence: 'missing speech',
    more: false,
    priority: 1,
    indices: [],
    detail: { reason: 'speech' },
  };
  await act(async () =>
    hook!.updateQualityReview({
      ...hook!.qualityReview,
      insertionDrafts: {
        ...hook!.qualityReview.insertionDrafts,
        [gap.key]: {
          start: '5',
          end: '6',
          source: 'Missing sentence',
          target: '',
        },
      },
    }),
  );
  await act(async () =>
    assert.equal(hook!.insertSubtitle(2, 4, 'Overlap', '', gap), false),
  );
  assert.equal(hook!.qualityReview.decisions[gap.key], undefined);
  assert.ok(
    hook!.qualityReview.insertionDrafts?.[gap.key],
    'invalid insertion retains draft',
  );
  const previousCount = hook!.mergedSubtitles.length;
  await act(async () =>
    assert.equal(hook!.insertSubtitle(5, 6, 'Missing sentence', '', gap), true),
  );
  assert.equal(hook!.qualityReview.decisions[gap.key].status, 'fixed');
  assert.equal(
    hook!.qualityReview.insertionDrafts?.[gap.key],
    undefined,
    'successful insertion clears only its draft',
  );
  assert.ok(
    hook!.qualityReview.insertionDrafts?.gap,
    'other drafts survive insertion',
  );
  await act(async () => hook!.handleUndo());
  assert.equal(
    hook!.mergedSubtitles.length,
    previousCount,
    'one undo removes the inserted subtitle',
  );
  assert.equal(
    hook!.qualityReview.decisions[gap.key],
    undefined,
    'the same undo restores the review status',
  );
  await act(async () => hook!.handleRedo());
  assert.equal(hook!.mergedSubtitles.length, previousCount + 1);
  assert.equal(hook!.qualityReview.decisions[gap.key].status, 'fixed');
  await act(async () => assert.equal(await hook!.handleSave(), true));
  await act(async () => root.unmount());
  files.clear();
  readFail = true;
  await act(async () => {
    root = create(<Harness />);
  });
  assert.match(hook!.qualityLoadError, /unreadable progress/);
  const beforeReadFailure = structuredClone(saved);
  await act(async () => assert.equal(await hook!.handleSave(), false));
  assert.deepEqual(
    saved,
    beforeReadFailure,
    'unreadable existing progress cannot be overwritten',
  );
  // A recovery draft is newer than the progress that becomes readable later.
  await act(async () =>
    hook!.updateQualityReview({
      ...hook!.qualityReview,
      insertionDrafts,
      decisions: { recovered: confirmed },
    }),
  );
  await act(async () => root.unmount());
  await act(async () => {
    root = create(<Harness />);
  });
  assert.ok(hook!.recoveryDraft);
  await act(async () => hook!.restoreDraft());
  readFail = false;
  await act(async () => hook!.retryQualityLoad());
  assert.equal(hook!.qualityLoadError, '');
  assert.deepEqual(
    hook!.qualityReview.insertionDrafts,
    insertionDrafts,
    'read retry preserves recovered text',
  );
  assert.deepEqual(hook!.qualityReview.decisions.recovered, confirmed);
  holdRead = true;
  let retrying: Promise<void>;
  act(() => {
    retrying = hook!.retryQualityLoad();
  });
  const latestDrafts = {
    gap: { ...insertionDrafts.gap, source: 'Typed during retry' },
  };
  await act(async () =>
    hook!.updateQualityReview({
      ...hook!.qualityReview,
      insertionDrafts: latestDrafts,
    }),
  );
  await act(async () => {
    releaseRead!();
    await retrying;
  });
  assert.deepEqual(hook!.qualityReview.insertionDrafts, latestDrafts);
  assert.deepEqual(
    JSON.parse(Array.from(files.values())[0]).qualityReview.insertionDrafts,
    latestDrafts,
  );
  await act(async () => assert.equal(await hook!.handleSave(), true));
  await act(async () => root.unmount());
  console.log(
    'Quality state: review-only writes, ordered undo/redo, failed writes, recovery, concurrent edits and insertion passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
