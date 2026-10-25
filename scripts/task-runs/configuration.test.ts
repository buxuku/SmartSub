import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureEffectiveConfiguration,
  resolveCredentials,
} from '../../main/helpers/taskRuns/configuration';
import { digestValue } from '../../main/helpers/taskRuns/service';
import { PROVIDER_TYPES } from '../../types/provider';
import { ASR_PROVIDER_TYPES } from '../../types/asrProvider';
import { TTS_PROVIDER_TYPES } from '../../types/ttsProvider';

test('all supported provider credentials are redacted and rotate together, including old snapshots', () => {
  const keys = new Set([
    ...[...PROVIDER_TYPES, ...ASR_PROVIDER_TYPES, ...TTS_PROVIDER_TYPES]
      .flatMap((provider) => provider.fields)
      .filter((field) => field.type === 'password')
      .map((field) => field.key),
    'appid',
    'appkey',
  ]);
  const original = Object.fromEntries(
    [...keys].map((key) => [key, `old-${key}`]),
  );
  const rotated = Object.fromEntries(
    [...keys].map((key) => [key, `new-${key}`]),
  );
  const live = {
    translationProviders: [{ id: 'account', model: 'original', ...original }],
  };
  const frozen = captureEffectiveConfiguration((key) => live[key], {});
  const fingerprint = digestValue(frozen);
  for (const key of keys) {
    assert.deepEqual(
      frozen.translationProviders[0][key],
      { $credential: true },
      key,
    );
  }
  live.translationProviders[0] = {
    id: 'account',
    model: 'changed',
    ...rotated,
  };
  const resolved = resolveCredentials(frozen, live);
  assert.equal(resolved.translationProviders[0].model, 'original');
  for (const key of keys)
    assert.equal(resolved.translationProviders[0][key], rotated[key], key);
  assert.equal(
    digestValue(
      captureEffectiveConfiguration(
        (key) =>
          key === 'translationProviders'
            ? [{ id: 'account', model: 'original', ...rotated }]
            : undefined,
        {},
      ),
    ),
    fingerprint,
  );
  const legacy = resolveCredentials(
    { translationProviders: [{ id: 'account', ...original }] },
    live,
  );
  for (const key of keys)
    assert.equal(legacy.translationProviders[0][key], rotated[key], key);
  assert.equal(
    resolveCredentials({ apiSecret: 'old-secret' }, {}).apiSecret,
    '',
  );
});
test('effective configuration freezes settings and provider parameters but resolves credentials by identity', () => {
  const live: any = {
    settings: { vadThreshold: 0.5 },
    translationProviders: [
      { id: 'a', model: 'original', apiKey: 'secret' },
      { id: 'b', model: 'other', apiKey: 'second' },
    ],
    glossaries: [{ id: 'terms', entries: ['old'] }],
  };
  const frozen = captureEffectiveConfiguration((key) => live[key], {
    a: {
      bodyParameters: { temperature: 0.3 },
      headerParameters: { authorization: 'Bearer private' },
    },
  });
  const fingerprint = digestValue(frozen);
  assert.ok(!JSON.stringify(frozen).includes('secret'));
  assert.ok(!JSON.stringify(frozen).includes('Bearer private'));
  live.translationProviders.reverse();
  live.translationProviders[1].apiKey = 'rotated';
  live.translationProviders[1].model = 'changed';
  live.settings.vadThreshold = 0.9;
  live.glossaries[0].entries.push('new');
  const resolved = resolveCredentials(frozen, live);
  assert.equal(resolved.translationProviders[0].apiKey, 'rotated');
  assert.equal(resolved.translationProviders[0].model, 'original');
  assert.equal(resolved.settings.vadThreshold, 0.5);
  assert.deepEqual(resolved.glossaries[0].entries, ['old']);
  assert.equal(digestValue(frozen), fingerprint);
});
