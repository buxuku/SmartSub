import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { act, create } from 'react-test-renderer';
import { useQualityReview } from '../renderer/hooks/useQualityReview';
import { emptyQualityReview } from '../types/qualityReview';
import type { Subtitle } from '../renderer/hooks/useSubtitles';

async function main() {
  const events = new EventTarget();
  let fail = false;
  let delayed: ((value: unknown) => void) | undefined;
  let hold = false;
  const glossaries = [
    {
      id: 'g',
      name: 'Terms',
      enabled: true,
      entries: [{ id: 't', source: 'API', target: '接口' }],
    },
  ];
  (globalThis as any).window = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    ipc: {
      invoke: async () => {
        if (hold)
          return new Promise((resolve) => {
            delayed = resolve;
          });
        if (fail) throw new Error('unreadable');
        return glossaries;
      },
    },
  };
  const row: Subtitle = {
    id: '1',
    startEndTime: '',
    content: ['API'],
    sourceContent: 'API',
    targetContent: '服务',
    startTimeInSeconds: 1,
    endTimeInSeconds: 3,
  };
  const warnings = [];
  let input = { documentKey: 'a', subtitles: [row] };
  let control: ReturnType<typeof useQualityReview>;
  const updates: Array<{ record?: boolean; dirty?: boolean }> = [];
  function Harness() {
    const [state, update] = useState(emptyQualityReview);
    control = useQualityReview({
      ...input,
      warnings,
      state,
      update: (next, record, dirty) => {
        updates.push({ record, dirty });
        update(next);
      },
      translation: true,
      enabled: true,
    });
    return null;
  }
  let root;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
  await act(async () => {
    root = create(<Harness />);
  });
  await settle();
  assert.equal(control!.counts.pending, 1);
  await act(async () => control!.view({ mode: 'issues' }));
  assert.equal(
    updates.at(-1)?.dirty,
    false,
    'view changes must not dirty the subtitle document',
  );
  const issue = control!.issues[0];
  await act(async () => control!.decide(issue, 'skipped'));
  assert.equal(control!.counts.skipped, 1);
  input = { ...input, subtitles: [{ ...row, targetContent: '接口' }] };
  await act(async () => root.update(<Harness />));
  await settle();
  assert.equal(control!.counts.fixed, 1);
  await act(async () => control!.retry());
  assert.equal(
    control!.counts.pending,
    0,
    'fixed issues stay fixed during recheck',
  );
  await settle();
  input = { ...input, subtitles: [{ ...row, targetContent: '另一译文' }] };
  await act(async () => root.update(<Harness />));
  await settle();
  assert.equal(
    control!.counts.pending,
    1,
    'changed evidence invalidates a skip',
  );
  fail = true;
  await act(async () => events.dispatchEvent(new Event('focus')));
  assert.match(control!.glossaryError, /unreadable/);
  assert.equal(
    control!.counts.pending,
    1,
    'read failure preserves glossary findings',
  );
  fail = false;
  await act(async () => control!.retry());
  await settle();
  assert.equal(control!.glossaryError, '');
  hold = true;
  await act(async () => events.dispatchEvent(new Event('focus')));
  hold = false;
  input = {
    documentKey: 'b',
    subtitles: [{ ...row, sourceContent: 'Hello', targetContent: '' }],
  };
  await act(async () => root.update(<Harness key="b" />));
  await act(async () => delayed!([]));
  // A second edit during the debounce supersedes the pending scan.
  input = {
    ...input,
    subtitles: [{ ...input.subtitles[0], targetContent: '你好' }],
  };
  await act(async () => root.update(<Harness key="b" />));
  await settle();
  assert.equal(control!.issues.length, 0);
  assert.equal(
    control!.terms.length,
    1,
    'late previous-document terms are ignored',
  );
  await act(async () => root.unmount());
  console.log(
    'Quality controller: debounce, evidence, rechecks, read failure and stale-document responses passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
