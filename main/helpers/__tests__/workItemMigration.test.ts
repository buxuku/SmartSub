/**
 * Unit tests for WorkItem migration (run with ts-node / manual node execution).
 */

import type { IFiles, TaskProject } from '../../../types';
import type { ProofreadTask } from '../../../types/proofread';
import {
  derivePipelineWorkItemStatus,
  migrateLegacyStoresToWorkItems,
  proofreadTaskToWorkItem,
  taskProjectToWorkItem,
} from '../workItemMigration';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, but got ${actual}`);
      }
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`,
        );
      }
    },
  };
}

function makeFile(overrides: Partial<IFiles> = {}): IFiles {
  return {
    uuid: 'file-1',
    filePath: '/tmp/demo.mp4',
    fileName: 'demo.mp4',
    fileExtension: 'mp4',
    directory: '/tmp',
    ...overrides,
  };
}

function testDerivePipelineStatus() {
  expect(derivePipelineWorkItemStatus([])).toBe('waiting');
  expect(derivePipelineWorkItemStatus([makeFile()])).toBe('waiting');
  expect(
    derivePipelineWorkItemStatus([
      makeFile({ extractAudio: 'loading' as unknown as boolean }),
    ]),
  ).toBe('running');
  expect(
    derivePipelineWorkItemStatus([
      makeFile({
        extractAudio: 'error' as unknown as boolean,
        ...({ extractAudioError: 'TASK_INTERRUPTED' } as Partial<IFiles>),
      }),
    ]),
  ).toBe('interrupted');
  expect(
    derivePipelineWorkItemStatus([
      makeFile({
        extractAudio: 'done' as unknown as boolean,
        extractSubtitle: 'done' as unknown as boolean,
      }),
    ]),
  ).toBe('done');
}

function testTaskProjectToWorkItem() {
  const project: TaskProject = {
    id: 'proj-1',
    name: 'Demo Project',
    taskType: 'translateOnly',
    files: [makeFile({ translateSubtitle: 'done' as unknown as boolean })],
    createdAt: 1000,
    updatedAt: 2000,
  };

  const workItem = taskProjectToWorkItem(project);
  expect(workItem.id).toBe('proj-1');
  expect(workItem.type).toBe('translateOnly');
  expect(workItem.status).toBe('done');
  expect(workItem.pipelineFiles?.length).toBe(1);
  expect(workItem.finishedAt).toBe(2000);
}

function testProofreadTaskToWorkItem() {
  const task: ProofreadTask = {
    id: 'proof-1',
    name: 'Batch',
    createdAt: 100,
    updatedAt: 200,
    currentItemIndex: 0,
    status: 'in_progress',
    items: [
      {
        id: 'item-1',
        sourceSubtitlePath: '/tmp/a.srt',
        lastPosition: 3,
        totalCount: 10,
        modifiedCount: 1,
        status: 'in_progress',
      },
    ],
  };

  const workItem = proofreadTaskToWorkItem(task);
  expect(workItem.type).toBe('proofread');
  expect(workItem.status).toBe('running');
  expect(workItem.proofreadEntries?.[0].id).toBe('item-1');
  expect(workItem.currentProofreadIndex).toBe(0);
}

function testMigrateLegacyStores() {
  const taskProject: TaskProject = {
    id: 'p1',
    name: 'Pipeline',
    taskType: 'generateOnly',
    files: [makeFile()],
    createdAt: 100,
    updatedAt: 300,
  };

  const proofreadTask: ProofreadTask = {
    id: 'pr1',
    name: 'Proofread',
    createdAt: 200,
    updatedAt: 400,
    currentItemIndex: 0,
    status: 'completed',
    items: [
      {
        id: 'i1',
        sourceSubtitlePath: '/tmp/b.srt',
        lastPosition: 0,
        totalCount: 0,
        modifiedCount: 0,
        status: 'completed',
      },
    ],
  };

  const result = migrateLegacyStoresToWorkItems({
    taskProjects: [taskProject],
    proofreadTasks: [proofreadTask],
  });

  expect(result.fromTaskProjects).toBe(1);
  expect(result.fromProofreadTasks).toBe(1);
  expect(result.items.length).toBe(2);
  expect(result.items[0].id).toBe('pr1');
  expect(result.items[1].id).toBe('p1');
}

export function runWorkItemMigrationTests() {
  testDerivePipelineStatus();
  testTaskProjectToWorkItem();
  testProofreadTaskToWorkItem();
  testMigrateLegacyStores();
  console.log('workItemMigration tests passed');
}

if (require.main === module) {
  runWorkItemMigrationTests();
}
