import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureEffectiveConfiguration, resolveCredentials } from '../../main/helpers/taskRuns/configuration';
import { digestValue } from '../../main/helpers/taskRuns/service';
test('effective configuration freezes settings and provider parameters but resolves credentials by identity', () => {
  const live: any = { settings: { vadThreshold: 0.5 }, translationProviders: [{ id: 'a', model: 'original', apiKey: 'secret' }, { id: 'b', model: 'other', apiKey: 'second' }], glossaries: [{ id: 'terms', entries: ['old'] }] };
  const frozen = captureEffectiveConfiguration(key => live[key], { a: { bodyParameters: { temperature: 0.3 }, headerParameters: { authorization: 'Bearer private' } } });
  const fingerprint = digestValue(frozen);
  assert.ok(!JSON.stringify(frozen).includes('secret'));
  assert.ok(!JSON.stringify(frozen).includes('Bearer private'));
  live.translationProviders.reverse(); live.translationProviders[1].apiKey = 'rotated'; live.translationProviders[1].model = 'changed'; live.settings.vadThreshold = 0.9; live.glossaries[0].entries.push('new');
  const resolved = resolveCredentials(frozen, live);
  assert.equal(resolved.translationProviders[0].apiKey, 'rotated');
  assert.equal(resolved.translationProviders[0].model, 'original');
  assert.equal(resolved.settings.vadThreshold, 0.5);
  assert.deepEqual(resolved.glossaries[0].entries, ['old']);
  assert.equal(digestValue(frozen), fingerprint);
});
