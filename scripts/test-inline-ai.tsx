import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  useInlineAi,
  type InlineAiControl,
} from '../renderer/hooks/useInlineAi';
import {
  canAcceptSuggestion,
  cueSnapshot,
  cueStructure,
} from '../renderer/lib/inlineAi';
import type { Subtitle } from '../renderer/hooks/useSubtitles';
import { subtitleHealth } from '../renderer/lib/subtitleHealth';

async function main() {
  assert.equal(
    subtitleHealth('一二三四五六七八', 0, 1, 'zh-CN').tooFast,
    false,
  );
  assert.equal(subtitleHealth('一二三四五六七八九', 0, 1, 'zh').tooFast, true);
  assert.equal(subtitleHealth('a'.repeat(20), 0, 1, 'en').tooFast, false);
  assert.equal(subtitleHealth('a'.repeat(21), 0, 1, 'en').tooFast, true);
  assert.equal(subtitleHealth('一二三四五六七八九', 0, 1).threshold, 8);
  assert.equal(subtitleHealth('e\u0301', 0, 1).characters, 1);
  assert.equal(subtitleHealth('a b\r\ncd', 0, 2).characters, 5);
  assert.equal(subtitleHealth('a b\ncd', 0, 2).longestLine, 3);
  assert.equal(subtitleHealth('text', 0, 0).cps, null);
  assert.equal(subtitleHealth('text', 2, 1).cps, null);
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: { en: { home: {} } }, initImmediate: false });
  const cue = (id: number): Subtitle => ({
    id: String(id),
    startEndTime: `${id}`,
    content: [],
    sourceContent: `Source ${id}`,
    targetContent: `Target ${id}`,
    startTimeInSeconds: id * 2,
    endTimeInSeconds: id * 2 + 1,
  });
  let cues = [cue(1), cue(2)];
  cues[0].translationStatus = 'failed';
  cues[0].translationError = 'Old error';
  let documentKey = 'first';
  let showTranslation = true;
  let updates = 0;
  const calls: Array<{
    channel: string;
    payload: any;
    resolve: (value: any) => void;
  }> = [];
  const cancelled: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const storage = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  (globalThis as any).window = {
    ipc: {
      on: (channel: string, fn: (...args: any[]) => void) => {
        listeners.set(channel, fn);
        return () => listeners.delete(channel);
      },
      invoke: (channel: string, payload: any) => {
        if (channel === 'getAiTranslationProviders')
          return Promise.resolve({
            success: true,
            data: [
              {
                id: 'fixture',
                type: 'openai',
                name: 'Fixture',
                apiKey: 'test',
                apiUrl: 'http://localhost',
                modelName: 'test',
                isAi: true,
              },
            ],
          });
        if (channel === 'cancelProofreadBatch') {
          cancelled.push(payload.batchId);
          return Promise.resolve({ success: true });
        }
        return new Promise((resolve) =>
          calls.push({ channel, payload, resolve }),
        );
      },
    },
  };
  let control: InlineAiControl;
  function Harness() {
    control = useInlineAi({
      documentKey,
      getSubtitles: () => cues,
      updateSubtitles: (next) => {
        cues = next;
        updates++;
      },
      shouldShowTranslation: showTranslation,
      sourceLanguage: 'ja',
      targetLanguage: 'fr',
    });
    return null;
  }
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness />);
  });
  assert.equal(control!.providerId, 'fixture');
  let pending: Promise<void>;
  act(() => {
    pending = control!.run([0]);
  });
  assert.equal(control!.suggestions.get(0)?.status, 'loading');
  assert.equal(calls.at(-1)?.payload.sourceLanguage, 'ja');
  assert.equal(calls.at(-1)?.payload.targetLanguage, 'fr');
  assert.equal(calls.at(-1)?.channel, 'optimizeSubtitle');
  await act(async () => {
    calls.at(-1)!.resolve({ success: true, data: 'Edited 1' });
    await pending;
  });
  act(() => assert.equal(control!.accept(0), true));
  assert.equal(cues[0].targetContent, 'Edited 1');
  assert.equal(cues[0].translationStatus, 'success');
  assert.equal(cues[0].translationError, undefined);
  assert.equal(cues[1].targetContent, 'Target 2');
  assert.equal(updates, 1);
  act(() => {
    pending = control!.run([1]);
  });
  cues[1] = { ...cues[1], targetContent: 'Concurrent edit' };
  await act(async () => {
    calls.at(-1)!.resolve({ success: true, data: 'Stale' });
    await pending;
  });
  act(() => assert.equal(control!.accept(1), false));
  assert.equal(cues[1].targetContent, 'Concurrent edit');
  act(() => control!.dismiss(1));
  act(() => {
    pending = control!.run([0]);
  });
  cues = [cue(3), ...cues];
  await act(async () => {
    calls.at(-1)!.resolve({ success: true, data: 'Wrong index' });
    await pending;
  });
  act(() => assert.equal(control!.accept(0), false));
  assert.equal(cues[0].sourceContent, 'Source 3');
  act(() => control!.dismiss(0));
  act(() => {
    pending = control!.run([0], 'shorten');
  });
  const oldRequest = calls.at(-1)!;
  assert.match(oldRequest.payload.customPrompt, /fewer characters/);
  act(() => control!.dismiss(0));
  await act(async () => {
    oldRequest.resolve({ success: true, data: 'Ignored' });
    await pending;
  });
  assert.equal(control!.suggestions.size, 0);
  act(() => {
    pending = control!.run([0, 1]);
  });
  const batch = calls.at(-1)!;
  assert.equal(batch.channel, 'batchOptimizeSubtitles');
  act(() =>
    listeners.get('batchOptimizeProgress')!({
      batchId: 'another-window',
      progress: 95,
    }),
  );
  assert.equal(control!.progress, 0);
  act(() =>
    listeners.get('batchOptimizeResult')!({
      batchId: batch.payload.batchId,
      index: 0,
      status: 'success',
      optimizedTarget: 'Streamed result',
    }),
  );
  assert.equal(control!.suggestions.get(0)?.status, 'ready');
  act(() => assert.equal(control!.accept(0), true));
  await act(async () => {
    batch.resolve({
      success: true,
      data: {
        results: [
          { index: 0, status: 'success', optimizedTarget: 'Streamed result' },
          { index: 1, status: 'success', optimizedTarget: 'Second result' },
        ],
      },
    });
    await pending;
  });
  assert.equal(
    control!.suggestions.has(0),
    false,
    'final results never reintroduce accepted rows',
  );
  act(() => assert.equal(control!.accept(1), true));
  assert.equal(cues[1].targetContent, 'Second result');
  act(() => {
    pending = control!.run([0]);
  });
  const late = calls.at(-1)!;
  act(() => control!.cancel());
  assert.ok(cancelled.includes(late.payload.batchId));
  await act(async () => {
    late.resolve({ success: true, data: 'After cancellation' });
    await pending;
  });
  assert.equal(control!.suggestions.size, 0);
  act(() => {
    pending = control!.run([0]);
  });
  const previousFile = calls.at(-1)!;
  documentKey = 'second';
  showTranslation = false;
  await act(async () => root!.update(<Harness />));
  assert.ok(cancelled.includes(previousFile.payload.batchId));
  await act(async () => {
    previousFile.resolve({ success: true, data: 'From old document' });
    await pending;
  });
  assert.equal(control!.suggestions.size, 0);
  act(() => {
    pending = control!.run([0]);
  });
  assert.equal(calls.at(-1)!.payload.mode, 'transcript');
  await act(async () => {
    calls
      .at(-1)!
      .resolve({ success: true, data: 'Corrected source\nSecond line' });
    await pending;
  });
  act(() => assert.equal(control!.accept(0), true));
  assert.deepEqual(cues[0].content, ['Corrected source', 'Second line']);
  assert.equal(cues[0].sourceContent, 'Corrected source\nSecond line');
  act(() => {
    pending = control!.run([0]);
  });
  await act(async () => {
    calls.at(-1)!.resolve({ success: true, data: '' });
    await pending;
  });
  assert.equal(control!.suggestions.get(0)?.status, 'error');
  act(() => assert.equal(control!.accept(0), false));
  act(() => {
    pending = control!.run([0]);
  });
  await act(async () => {
    calls.at(-1)!.resolve({ success: false, error: 'Service unavailable' });
    await pending;
  });
  assert.match(control!.suggestions.get(0)?.error || '', /Service unavailable/);
  act(() => {
    pending = control!.run([0]);
  });
  const unmounted = calls.at(-1)!;
  act(() => root!.unmount());
  assert.ok(cancelled.includes(unmounted.payload.batchId));
  unmounted.resolve({ success: true, data: 'After unmount' });
  await pending!;
  assert.equal(listeners.size, 0);
  const ready = {
    requestId: 'test',
    index: 0,
    snapshot: cueSnapshot(cues[0]),
    structure: cueStructure(cues),
    original: '',
    proposed: 'Safe',
    field: 'sourceContent' as const,
    intent: 'polish' as const,
    status: 'ready' as const,
  };
  assert.ok(canAcceptSuggestion(ready, cues));
  assert.equal(canAcceptSuggestion(ready, cues.slice(1)), false);
  assert.equal(
    canAcceptSuggestion(ready, [
      { ...cues[0], endTimeInSeconds: 99 },
      ...cues.slice(1),
    ]),
    false,
  );
  console.log(
    'Inline AI: request identity, stale edits/structure, streaming, language, cancellation, file switch, error, unmount passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
