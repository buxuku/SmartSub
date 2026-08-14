import {
  PROOFREAD_DATA_VERSION,
  normalizeMetaGlossaryIds,
  normalizeProofreadData,
} from '../types/proofreadData';
import { loadSidecarGlossaryIds } from '../main/helpers/sidecarGlossaryIds';

let passed = 0;
let failed = 0;

function ok(value: unknown, name: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`x ${name}`);
  }
}

function equal<T>(actual: T, expected: T, name: string): void {
  const success = JSON.stringify(actual) === JSON.stringify(expected);
  ok(success, name);
  if (!success) {
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

function sidecar(
  version: 1 | 2,
  metaExtra: Record<string, unknown> = {},
): unknown {
  return {
    version,
    meta: {
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      ...metaExtra,
    },
    cues: [],
    ...(version === 2 ? { speakers: [] } : {}),
  };
}

function testKeepsExplicitGlossaryIds(): void {
  equal(
    normalizeMetaGlossaryIds(['a', 'b']),
    ['a', 'b'],
    'normalizeMetaGlossaryIds keeps [a,b] in order',
  );
  const result = normalizeProofreadData(
    sidecar(2, { glossaryIds: ['a', 'b'] }),
  );
  equal(
    result.meta.glossaryIds,
    ['a', 'b'],
    'normalizeProofreadData keeps glossaryIds [a,b] in order',
  );
}

function testKeepsEmptyGlossaryIds(): void {
  equal(
    normalizeMetaGlossaryIds([]),
    [],
    'normalizeMetaGlossaryIds keeps empty array (explicit no glossary)',
  );
  const result = normalizeProofreadData(sidecar(2, { glossaryIds: [] }));
  equal(
    result.meta.glossaryIds,
    [],
    'normalizeProofreadData keeps empty glossaryIds (must not drop to undefined)',
  );
  ok(
    Object.prototype.hasOwnProperty.call(result.meta, 'glossaryIds'),
    'empty glossaryIds remains an own key after normalize',
  );
}

function assertLegacySidecarHasNoGlossaryIds(
  version: 1 | 2,
  name: string,
): void {
  const result = normalizeProofreadData(sidecar(version));
  equal(result.version, PROOFREAD_DATA_VERSION, `${name} upgrades to v2`);
  equal(
    result.meta.glossaryIds,
    undefined,
    `${name} glossaryIds stays undefined`,
  );
  ok(
    !Object.prototype.hasOwnProperty.call(result.meta, 'glossaryIds'),
    `${name} does not write an explicit undefined glossaryIds key`,
  );
}

function testLegacySidecarOmitsGlossaryIds(): void {
  assertLegacySidecarHasNoGlossaryIds(1, 'v1 sidecar');
  assertLegacySidecarHasNoGlossaryIds(2, 'v2 sidecar');
}

function testMalformedGlossaryIdsBecomeUndefined(): void {
  const malformed: unknown[] = [null, 'abc', 42, {}, true];
  for (const value of malformed) {
    const label = JSON.stringify(value);
    equal(
      normalizeMetaGlossaryIds(value),
      undefined,
      `normalizeMetaGlossaryIds(${label}) is undefined (not [])`,
    );
    const result = normalizeProofreadData(sidecar(2, { glossaryIds: value }));
    equal(
      result.meta.glossaryIds,
      undefined,
      `normalizeProofreadData(${label}) glossaryIds is undefined (not [])`,
    );
    ok(
      !Object.prototype.hasOwnProperty.call(result.meta, 'glossaryIds'),
      `normalizeProofreadData(${label}) omits glossaryIds key`,
    );
  }
}

function testUnknownMetaFieldsArePreserved(): void {
  const result = normalizeProofreadData(
    sidecar(2, { episodeSummary: 'x', futureField: 42 }),
  );
  equal(
    (result.meta as { episodeSummary?: string }).episodeSummary,
    'x',
    'unknown episodeSummary is preserved through normalize',
  );
  equal(
    (result.meta as { futureField?: number }).futureField,
    42,
    'unknown futureField is preserved through normalize',
  );
}

function testDropsNonStringGlossaryIdMembers(): void {
  equal(
    normalizeMetaGlossaryIds(['a', 1, null, 'b', {}]),
    ['a', 'b'],
    'normalizeMetaGlossaryIds drops non-string members and keeps order',
  );
  equal(
    normalizeProofreadData(sidecar(2, { glossaryIds: ['a', 1, null, 'b', {}] }))
      .meta.glossaryIds,
    ['a', 'b'],
    'normalizeProofreadData drops non-string glossaryIds members',
  );
  equal(
    normalizeMetaGlossaryIds([1, null]),
    [],
    'all-invalid members stay [] (explicit empty, not undefined)',
  );
  equal(
    normalizeProofreadData(sidecar(2, { glossaryIds: [1, null] })).meta
      .glossaryIds,
    [],
    'normalizeProofreadData keeps [] when every member is invalid',
  );
}

async function testSidecarGlossaryIdsLoadBoundary(): Promise<void> {
  let absentReadCount = 0;
  equal(
    await loadSidecarGlossaryIds(undefined, async () => {
      absentReadCount++;
      return { meta: { glossaryIds: ['unexpected'] } };
    }),
    undefined,
    'missing sidecar path falls back without reading a file',
  );
  equal(absentReadCount, 0, 'missing sidecar path does not call the reader');

  equal(
    await loadSidecarGlossaryIds('explicit-empty.json', async () => ({
      meta: { glossaryIds: [] },
    })),
    [],
    'sidecar keeps an explicit empty glossary selection',
  );
  equal(
    await loadSidecarGlossaryIds('legacy.json', async () => ({ meta: {} })),
    undefined,
    'legacy sidecar without glossaryIds falls back to globally enabled',
  );

  const corrupt = new Error('corrupt sidecar');
  let observed: unknown;
  try {
    await loadSidecarGlossaryIds('corrupt.json', async () => {
      throw corrupt;
    });
  } catch (error) {
    observed = error;
  }
  ok(
    observed === corrupt,
    'sidecar read or parse errors propagate instead of falling back globally',
  );
}

async function main(): Promise<void> {
  testKeepsExplicitGlossaryIds();
  testKeepsEmptyGlossaryIds();
  testLegacySidecarOmitsGlossaryIds();
  testMalformedGlossaryIdsBecomeUndefined();
  testDropsNonStringGlossaryIdMembers();
  testUnknownMetaFieldsArePreserved();
  await testSidecarGlossaryIdsLoadBoundary();

  console.log(`\nproofread-data tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
