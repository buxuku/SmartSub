import assert from 'node:assert/strict';
import { DubbingSessionOwnership } from '../../main/helpers/dubbing/sessionOwnership';

const ownership = new DubbingSessionOwnership();
assert.equal(ownership.acquire('first', 1, ''), false);
assert.equal(ownership.acquire('first', 1, 'a'), true);
assert.equal(ownership.acquire('first', 1, 'a'), true);
assert.equal(ownership.acquire('first', 2, 'a'), false);
assert.equal(ownership.acquire('first', 1, 'b'), false);
assert.deepEqual(ownership.owner('first'), { windowId: 1, leaseId: 'a' });
assert.equal(ownership.owns('first', 2, 'a'), false);
assert.equal(ownership.release('first', 2, 'a'), false);
assert.equal(ownership.release('first', 1, 'b'), false);
assert.equal(ownership.acquire('second', 2, 'b'), true);
assert.equal(ownership.acquire('third', 1, 'c'), true);
assert.deepEqual(ownership.releaseOwner(1), ['first', 'third']);
assert.deepEqual(ownership.owner('second'), { windowId: 2, leaseId: 'b' });
assert.equal(ownership.acquire('first', 1, 'replacement'), true);
assert.equal(ownership.owns('first', 1, 'a'), false);
assert.equal(ownership.release('first', 1, 'a'), false);
assert.deepEqual(ownership.releaseOwner(1, 'a'), []);
assert.equal(ownership.release('first', 1, 'replacement'), true);
assert.equal(ownership.owner('first'), undefined);
assert.deepEqual(ownership.releaseOwner(1), []);
assert.equal(ownership.acquire('first', 1, 'retired'), true);
assert.deepEqual(ownership.retire(1, 'retired'), ['first']);
assert.equal(ownership.acquire('first', 1, 'retired'), false);
assert.equal(ownership.acquire('new', 1, 'retired'), false);
assert.deepEqual(ownership.retire(1, 'not-started'), []);
assert.equal(ownership.acquire('new', 1, 'not-started'), false);
assert.equal(ownership.acquire('first', 2, 'retired'), true);
ownership.forgetWindow(1);
assert.equal(ownership.isRetired(1, 'retired'), false);
assert.throws(() => ownership.acquirePipeline('first'), /open in an editor/);
const releasePipeline = ownership.acquirePipeline('pipeline');
assert.equal(ownership.isBusy('pipeline'), true);
assert.equal(ownership.acquire('pipeline', 1, 'waiting'), false);
assert.throws(
  () => ownership.acquirePipeline('pipeline'),
  /running in a pipeline/,
);
releasePipeline();
assert.equal(ownership.acquire('pipeline', 1, 'waiting'), true);
releasePipeline();
assert.equal(ownership.owns('pipeline', 1, 'waiting'), true);
console.log(
  'Dubbing ownership: competing owners, idempotent acquisition, independent sessions, late release and crash cleanup passed.',
);
