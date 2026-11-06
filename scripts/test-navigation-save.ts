import assert from 'node:assert/strict';
import { saveNavigationGuards } from '../renderer/lib/navigationSave';

async function main() {
  const guards = new Map<
    string,
    {
      isDirty: boolean;
      getIsDirty?: () => boolean;
      onSave?: () => Promise<boolean>;
    }
  >();
  const calls: string[] = [];
  let firstDirty = true;
  let secondDirty = true;
  guards.set('first', {
    isDirty: true,
    getIsDirty: () => firstDirty,
    onSave: async () => {
      calls.push('first');
      firstDirty = false;
      return true;
    },
  });
  guards.set('second', {
    isDirty: true,
    getIsDirty: () => secondDirty,
    onSave: async () => {
      calls.push('second');
      secondDirty = false;
      firstDirty = true;
      return true;
    },
  });
  assert.equal(
    await saveNavigationGuards(guards),
    'changed',
    'earlier editor changed while later editor saved',
  );
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(
    await saveNavigationGuards(guards),
    'saved',
    'synchronous source overrides stale rendered dirty state',
  );
  guards.set('new', {
    isDirty: true,
    onSave: async () => {
      guards.set('new', { isDirty: false });
      guards.set('added-during-save', { isDirty: true });
      return true;
    },
  });
  assert.equal(
    await saveNavigationGuards(guards),
    'changed',
    'newly registered editor cannot be skipped',
  );
  assert.equal(
    await saveNavigationGuards(guards),
    'failed',
    'unsaveable editor blocks leaving',
  );
  guards.clear();
  guards.set('stale', { isDirty: true, onSave: async () => true });
  assert.equal(
    await saveNavigationGuards(guards),
    'changed',
    'success response alone cannot bypass dirty state',
  );
  guards.set('stale', { isDirty: true, onSave: async () => false });
  assert.equal(await saveNavigationGuards(guards), 'failed');
  guards.set('stale', {
    isDirty: true,
    onSave: async () => {
      throw new Error('IPC failed');
    },
  });
  await assert.rejects(saveNavigationGuards(guards), /IPC failed/);
  guards.clear();
  assert.equal(await saveNavigationGuards(guards), 'saved');
  console.log(
    'Navigation save: concurrent edits, synchronous dirty state, new guards, strict revalidation and failures passed.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
