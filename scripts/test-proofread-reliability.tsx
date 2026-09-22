import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useStandaloneSubtitles } from '../renderer/hooks/useStandaloneSubtitles';
import {
  proofreadDraftKey,
  clearProofreadDraft,
} from '../renderer/lib/proofreadDraft';
import { saveNavigationGuards } from '../renderer/lib/navigationSave';

async function main() {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: { en: { home: {} } }, initImmediate: false });
  const storage = new Map<string, string>();
  let response: any = { success: true };
  let saveCalls = 0;
  let releaseSave: (() => void) | undefined;
  let delaySave = false;
  const writes: any[] = [];
  (globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    ipc: {
      invoke: async (channel: string, payload: any) => {
        if (channel === 'readSubtitleFile')
          return [
            {
              id: '1',
              startEndTime: '00:00:01,000 --> 00:00:03,000',
              content: ['Original'],
            },
          ];
        if (channel === 'saveSubtitleFile') {
          saveCalls++;
          writes.push(payload);
          if (delaySave)
            await new Promise<void>((resolve) => {
              releaseSave = resolve;
            });
          return response;
        }
        throw new Error(`Unexpected IPC: ${channel}`);
      },
    },
  };
  const config = { sourceSubtitlePath: '/tmp/smartsub-reliability.srt' };
  const key = proofreadDraftKey(config);
  clearProofreadDraft(key);
  let hook: ReturnType<typeof useStandaloneSubtitles>;
  function Harness() {
    hook = useStandaloneSubtitles(config, true);
    return null;
  }
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness />);
  });
  assert.equal(hook.mergedSubtitles.length, 1);
  await act(async () =>
    hook.handleSubtitleChange(0, 'sourceContent', 'First edit'),
  );
  assert.equal(hook.isDirty, true);
  assert.equal(
    JSON.parse(storage.get(key)!).subtitles[0].sourceContent,
    'First edit',
  );

  for (const failure of [
    undefined,
    {},
    { success: false },
    { error: 'Disk full' },
  ]) {
    response = failure;
    await act(async () => assert.equal(await hook.handleSave(), false));
    assert.equal(hook.isDirty, true);
    assert.equal(hook.saveStatus, 'save_error');
    assert.ok(storage.has(key));
  }

  response = { success: true };
  delaySave = true;
  let saving: Promise<boolean>;
  const beforeCalls = saveCalls;
  act(() => {
    saving = hook.handleSave();
  });
  act(() => {
    assert.equal(hook.handleSave(), saving, 'Concurrent saves share one write');
  });
  await act(async () =>
    hook.handleSubtitleChange(0, 'sourceContent', 'Edit during save'),
  );
  await act(async () => {
    releaseSave!();
    assert.equal(await saving, false);
  });
  assert.equal(saveCalls, beforeCalls + 1);
  assert.equal(writes.at(-1).subtitles[0].sourceContent, 'First edit');
  assert.equal(hook.isDirty, true, 'An older save must not clear newer edits');
  assert.equal(
    JSON.parse(storage.get(key)!).subtitles[0].sourceContent,
    'Edit during save',
  );

  await act(async () => root.unmount());
  await act(async () => {
    root = create(<Harness />);
  });
  assert.ok(hook.recoveryDraft);
  assert.equal(hook.mergedSubtitles[0].sourceContent, 'Original');
  await act(async () => hook.restoreDraft());
  assert.equal(hook.mergedSubtitles[0].sourceContent, 'Edit during save');
  assert.equal(hook.isDirty, true);

  delaySave = false;
  await act(async () => assert.equal(await hook.handleSave(), true));
  assert.equal(hook.saveStatus, 'saved');
  assert.equal(hook.isDirty, false);
  assert.equal(storage.has(key), false);
  await act(async () =>
    hook.handleSubtitleChange(0, 'sourceContent', 'Before navigation save'),
  );
  const guards = new Map([
    [
      'subtitle',
      {
        isDirty: true,
        getIsDirty: hook.getIsDirty,
        onSave: () => hook.handleSave(),
      },
    ],
    [
      'other',
      { isDirty: true, getIsDirty: () => false, onSave: async () => true },
    ],
  ]);
  guards.set('other', {
    isDirty: true,
    getIsDirty: () => true,
    onSave: async () => {
      hook.handleSubtitleChange(
        0,
        'sourceContent',
        'New edit while other guard saves',
      );
      guards.set('other', {
        isDirty: false,
        getIsDirty: () => false,
        onSave: async () => true,
      });
      return true;
    },
  });
  await act(async () =>
    assert.equal(await saveNavigationGuards(guards), 'changed'),
  );
  assert.equal(hook.getIsDirty(), true);
  assert.equal(
    hook.mergedSubtitles[0].sourceContent,
    'New edit while other guard saves',
  );
  await act(async () =>
    assert.equal(await saveNavigationGuards(guards), 'saved'),
  );
  assert.equal(hook.getIsDirty(), false);
  const beforeTime = hook.mergedSubtitles[0].startEndTime;
  for (const [start, end] of [
    [-1, 2],
    [NaN, 2],
    [1, Infinity],
    [1, 1.0001],
  ]) {
    act(() =>
      assert.equal(
        hook.handleTimeChange(0, start, end),
        'timeEditInvalidRange',
      ),
    );
    assert.equal(hook.mergedSubtitles[0].startEndTime, beforeTime);
    assert.equal(hook.getIsDirty(), false);
  }
  act(() => hook.handleTimeChange(0, 1.12345, 2.12345));
  assert.equal(hook.mergedSubtitles[0].startTimeInSeconds, 1.123);
  assert.equal(hook.mergedSubtitles[0].endTimeInSeconds, 2.123);
  act(() => hook.handleUndo());
  assert.equal(hook.mergedSubtitles[0].startEndTime, beforeTime);
  for (const [point, time] of [
    [0, 2],
    [5000, 2],
    [2, 1],
    [2, 3],
    [2, NaN],
    [2, 1.0001],
  ]) {
    act(() => hook.handleSplitSubtitle(0, point, time));
    assert.equal(hook.mergedSubtitles.length, 1);
  }
  act(() => hook.handleSplitSubtitle(0, 3, 2));
  assert.equal(hook.mergedSubtitles.length, 2);
  assert.equal(hook.mergedSubtitles[0].endTimeInSeconds, 2);
  assert.equal(hook.mergedSubtitles[1].startTimeInSeconds, 2);
  act(() =>
    assert.equal(hook.handleTimeChange(1, 1.9, 3), 'timeEditOverlapPrev'),
  );
  act(() => hook.handleMergeSubtitles(0, 2));
  assert.equal(hook.mergedSubtitles.length, 1);
  act(() => hook.handleUndo());
  assert.equal(hook.mergedSubtitles.length, 2);
  act(() => hook.handleUndo());
  assert.equal(hook.mergedSubtitles.length, 1);
  act(() => hook.handleRedo());
  assert.equal(hook.mergedSubtitles.length, 2);
  await act(async () => root.unmount());
  console.log(
    'Proofread reliability: malformed/failing responses, draft recovery, concurrent saves and edits during save passed.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
