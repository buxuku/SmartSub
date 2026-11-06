import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  planGlossaryReplacement,
  replaceGlossaryTerm,
} from '../renderer/lib/contextGlossary';
import {
  useRetranslateFailed,
  type RetranslateControl,
} from '../renderer/hooks/useRetranslateFailed';
import type { Subtitle } from '../renderer/hooks/useSubtitles';

async function main() {
  assert.deepEqual(
    replaceGlossaryTerm('cat category cat_cat cat!', 'cat', '$&'),
    { text: '$& category cat_cat $&!', count: 2 },
  );
  assert.deepEqual(replaceGlossaryTerm('xa-a-a', 'a-a', 'WORD'), {
    text: 'xa-WORD',
    count: 1,
  });
  assert.deepEqual(replaceGlossaryTerm('爱丽丝和爱丽丝', '爱丽丝', '艾丽丝'), {
    text: '艾丽丝和艾丽丝',
    count: 2,
  });
  assert.deepEqual(replaceGlossaryTerm('C++ C++', 'C++', 'CPP'), {
    text: 'CPP CPP',
    count: 2,
  });
  assert.equal(replaceGlossaryTerm('Alice', '', 'Term').count, 0);
  assert.equal(replaceGlossaryTerm('Alice', 'Alice', 'Alice').count, 0);
  const row = (id: string): Subtitle => ({
    id,
    startEndTime: id,
    startTimeInSeconds: 0,
    endTimeInSeconds: 1,
    sourceContent: 'Alice says hello',
    targetContent: 'Alice',
    content: ['Alice says hello'],
    translationStatus: 'failed',
  });
  let cues = [row('1'), row('2')];
  const snapshot = JSON.stringify(cues);
  const translation = planGlossaryReplacement(
    cues,
    'targetContent',
    'Alice',
    '艾丽丝',
  );
  assert.equal(translation.count, 2);
  assert.equal(translation.next[0].sourceContent, cues[0].sourceContent);
  assert.deepEqual(translation.next[0].content, cues[0].content);
  const source = planGlossaryReplacement(
    cues,
    'sourceContent',
    'Alice',
    'Alicia',
  );
  assert.deepEqual(source.next[0].content, ['Alicia says hello']);
  assert.equal(source.next[0].targetContent, 'Alice');
  assert.equal(source.snapshot, snapshot);
  assert.equal(
    JSON.stringify(cues),
    snapshot,
    'preview leaves current subtitles untouched',
  );
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: { en: { home: {} } }, initImmediate: false });
  const calls: Array<{ payload: any; resolve: (result: any) => void }> = [];
  const cancelled: string[] = [];
  const listeners = new Map<string, any>();
  (globalThis as any).window = {
    ipc: {
      on: (name: string, fn: any) => {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
      invoke: (name: string, payload: any) => {
        if (name === 'cancelProofreadBatch') {
          cancelled.push(payload.batchId);
          return Promise.resolve({ success: true });
        }
        return new Promise((resolve) => calls.push({ payload, resolve }));
      },
    },
  };
  let control: RetranslateControl;
  let updates = 0;
  let documentKey = 'first';
  function Harness() {
    control = useRetranslateFailed({
      documentKey,
      projectId: 'a',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      getSubtitles: () => cues,
      getFailedTranslationIndices: () => [0, 1],
      updateSubtitles: (next) => {
        cues = next;
        updates++;
      },
    });
    return null;
  }
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness />);
  });
  act(() => {
    control!.start();
  });
  assert.equal(calls.at(-1)!.payload.projectId, 'a');
  cues[0] = { ...cues[0], targetContent: 'Manual edit' };
  await act(async () =>
    calls.at(-1)!.resolve({
      success: true,
      data: [
        { id: '1', startEndTime: '1', targetContent: 'Must not overwrite' },
        { id: '2', startEndTime: '2', targetContent: 'Good translation' },
      ],
    }),
  );
  assert.equal(cues[0].targetContent, 'Manual edit');
  assert.equal(cues[1].targetContent, 'Good translation');
  assert.equal(updates, 1);
  act(() => {
    control!.start();
  });
  const previous = calls.at(-1)!;
  documentKey = 'second';
  await act(async () => root!.update(<Harness />));
  assert.ok(cancelled.includes(previous.payload.batchId));
  await act(async () =>
    previous.resolve({
      success: true,
      data: [{ id: '1', startEndTime: '1', targetContent: 'Old file' }],
    }),
  );
  assert.equal(updates, 1);
  act(() => {
    control!.start();
  });
  const unmounted = calls.at(-1)!;
  act(() => root!.unmount());
  assert.ok(cancelled.includes(unmounted.payload.batchId));
  await act(async () => unmounted.resolve({ success: true, data: [] }));
  assert.equal(listeners.size, 0);
  console.log(
    'Context glossary: literal boundaries, overlapping candidates, immutable previews, column isolation and retranslation lifecycle passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
