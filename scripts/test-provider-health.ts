import assert from 'node:assert/strict';
import {
  getProviderHealth,
  recordProviderHealth,
} from '../main/helpers/providerHealth';

const provider = {
  id: 'same-id',
  apiKey: 'test-secret',
  custom: { headers: { a: 1, b: 2 }, values: ['a', 'b'] },
};
const originalNow = Date.now;
let now = 1000000;
Date.now = () => now;
try {
  assert.equal(getProviderHealth('translation', provider), null);
  recordProviderHealth(
    'translation',
    { ...provider, strictStructuredOutput: true },
    true,
  );
  assert.equal(
    getProviderHealth('translation', provider)?.status,
    'connected',
    'test-only flag must not change cache identity',
  );
  const reordered = {
    apiKey: provider.apiKey,
    custom: { values: ['a', 'b'], headers: { b: 2, a: 1 } },
    id: provider.id,
  };
  assert.equal(
    getProviderHealth('translation', reordered)?.status,
    'connected',
    'nested key order must not invalidate a test',
  );
  assert.equal(
    getProviderHealth('asr', provider),
    null,
    'kinds cannot share cached success',
  );
  assert.equal(
    getProviderHealth('translation', { ...provider, apiKey: 'changed' }),
    null,
  );
  assert.equal(
    getProviderHealth('translation', {
      ...provider,
      custom: { ...provider.custom, values: ['b', 'a'] },
    }),
    null,
    'array order is significant',
  );
  const publicResult = getProviderHealth('translation', provider)!;
  assert.deepEqual(Object.keys(publicResult).sort(), [
    'checkedAt',
    'id',
    'kind',
    'status',
  ]);
  assert.ok(!JSON.stringify(publicResult).includes('test-secret'));
  publicResult.status = 'failed';
  assert.equal(getProviderHealth('translation', provider)?.status, 'connected');
  recordProviderHealth('translation', provider, false);
  assert.equal(getProviderHealth('translation', provider)?.status, 'failed');
  now += 299999;
  assert.ok(getProviderHealth('translation', provider));
  now++;
  assert.equal(
    getProviderHealth('translation', provider),
    null,
    'five-minute TTL expires at boundary',
  );
  recordProviderHealth('tts', provider, true);
  assert.equal(getProviderHealth('tts', provider)?.status, 'connected');
  now--;
  assert.equal(
    getProviderHealth('tts', provider),
    null,
    'clock rollback must not keep stale success',
  );
  for (let i = 0; i < 300; i++)
    recordProviderHealth('asr', { id: `bounded-${i}` }, true);
  assert.equal(getProviderHealth('asr', { id: 'bounded-0' }), null);
  assert.equal(
    getProviderHealth('asr', { id: 'bounded-299' })?.status,
    'connected',
  );
  console.log(
    'Provider health: configuration identity, strict test flag, TTL, secret isolation, TTS and bounded cache passed.',
  );
} finally {
  Date.now = originalNow;
}
