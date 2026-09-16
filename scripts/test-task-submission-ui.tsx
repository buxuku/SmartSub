import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useTaskSubmission } from '../renderer/hooks/useTaskSubmission';
import useIpcCommunication from '../renderer/hooks/useIpcCommunication';
import { getTaskTypeBySlug } from '../renderer/lib/taskTypes';
import type {
  TaskSubmission,
  PendingTaskSubmission,
} from '../types/taskSubmission';

async function main() {
  await i18next
    .use(initReactI18next)
    .init({ lng: 'en', resources: { en: { home: {} } }, initImmediate: false });
  const sent: TaskSubmission[] = [];
  let response: any;
  let delayed = false;
  let release: (() => void) | undefined;
  let readDelayed = false;
  let releaseRead: (() => void) | undefined;
  let pending: PendingTaskSubmission | undefined;
  (globalThis as any).window = {
    ipc: {
      invoke: async (channel: string, payload: any) => {
        if (channel === 'getSystemInfo') {
          if (readDelayed)
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          return { modelsInstalled: ['base'] };
        }
        if (
          channel === 'getTranslationProviders' ||
          channel === 'getAsrProviders'
        )
          return [];
        if (channel === 'getSettings') return {};
        if (channel === 'checkFileExists') return { exists: true };
        if (channel === 'submitTask') {
          sent.push(structuredClone(payload));
          if (delayed)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return response === 'ack'
            ? {
                success: true,
                projectId: payload.projectId,
                requestId: payload.requestId,
                acceptedFileUuids: payload.files.map((file: any) => file.uuid),
                duplicate: false,
              }
            : response;
        }
        throw new Error(`Unexpected IPC ${channel}`);
      },
    },
  };
  let hook: ReturnType<typeof useTaskSubmission>;
  function Harness() {
    hook = useTaskSubmission({
      readPending: () => pending,
      savePending: (value) => {
        pending = value;
      },
    });
    return null;
  }
  const input = {
    projectId: 'project',
    files: [{ uuid: 'file', filePath: '/input.mp4', fileName: 'input' }] as any,
    typeDef: getTaskTypeBySlug('generate')!,
    formData: {
      taskType: 'generateOnly' as const,
      transcriptionEngine: 'builtin',
      model: 'base',
      nested: { value: 1 },
    },
  };
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness />);
  });
  for (const malformed of [
    undefined,
    {},
    { success: false, error: 'ENOSPC' },
    { success: true, projectId: 'wrong' },
  ]) {
    response = malformed;
    await act(async () => {
      await assert.rejects(hook.submit(input));
    });
    assert.equal(hook.phase, 'failed');
    assert.equal(hook.starting, false);
  }
  assert.equal(
    new Set(sent.map((item) => item.requestId)).size,
    1,
    'uncertain responses reuse request identity',
  );
  await act(async () => root.unmount());
  await act(async () => {
    root = create(<Harness />);
  });
  response = 'ack';
  delayed = true;
  let running: ReturnType<typeof hook.submit>;
  act(() => {
    running = hook.submit(input);
  });
  await act(async () => {
    await new Promise(setImmediate);
  });
  assert.equal(hook.phase, 'submitting');
  assert.equal(
    sent.at(-1)!.requestId,
    sent[0].requestId,
    'restored draft reuses uncertain request identity',
  );
  const before = sent.length;
  await act(async () => {
    assert.equal((await hook.submit(input)).status, 'cancelled');
  });
  assert.equal(sent.length, before, 'concurrent clicks cannot dispatch twice');
  input.formData.nested.value = 2;
  await act(async () => {
    release!();
    assert.equal((await running).status, 'accepted');
  });
  assert.equal(
    sent.at(-1)!.formData.nested.value,
    1,
    'snapshot is isolated while awaiting response',
  );
  readDelayed = true;
  act(() => {
    running = hook.submit(input);
  });
  await act(async () => {
    await new Promise(setImmediate);
    root.unmount();
  });
  releaseRead!();
  assert.equal((await running).status, 'cancelled');
  assert.equal(
    sent.length,
    before,
    'unmount during preflight cannot launch a task later',
  );
  const listeners = new Map<string, (...args: any[]) => void>();
  (window.ipc as any).on = (
    channel: string,
    callback: (...args: any[]) => void,
  ) => {
    listeners.set(channel, callback);
    return () => listeners.delete(channel);
  };
  let files: any[] = [{ uuid: 'shared' }];
  let hydrate: ReturnType<typeof useIpcCommunication>['hydrateFiles'];
  function EventHarness({ projectId }: { projectId: string }) {
    hydrate = useIpcCommunication(
      (update: any) => {
        files = typeof update === 'function' ? update(files) : update;
      },
      undefined,
      projectId,
    ).hydrateFiles;
    return null;
  }
  await act(async () => {
    root = create(<EventHarness projectId="first" />);
  });
  listeners.get('taskStatusChange')!(
    { uuid: 'shared', taskProjectId: 'second' },
    'extractSubtitle',
    'done',
  );
  assert.equal(files[0].extractSubtitle, undefined);
  listeners.get('taskStatusChange')!(
    { uuid: 'shared', taskProjectId: 'first' },
    'extractSubtitle',
    'done',
  );
  assert.equal(files[0].extractSubtitle, 'done');
  listeners.get('taskFileChange')!({
    uuid: 'not-loaded',
    taskProjectId: 'first',
    extractSubtitle: 'done',
  });
  await act(async () => root.update(<EventHarness projectId="second" />));
  hydrate([{ uuid: 'not-loaded' } as any]);
  assert.equal(
    files[0].extractSubtitle,
    undefined,
    'old project pending events cannot contaminate a new project',
  );
  await act(async () => root.unmount());
  console.log(
    'Task submission UI: strict acknowledgement, retry identity, restored request, concurrency, immutable snapshot and unmount cancellation passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
