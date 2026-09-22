import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkQuality,
  createQualityCheckCache,
  locateQualityIssue,
  mergeQualityCatalog,
} from '../renderer/lib/qualityChecks';
import {
  emptyQualityReview,
  qualityStatus,
  parseQualityReview,
} from '../types/qualityReview';
import { createQualityReviewStore } from '../main/helpers/qualityReviewStore';
import type { Subtitle } from '../renderer/hooks/useSubtitles';

const cue = (
  source: string,
  target = 'Good.',
  start = 1,
  end = 3,
): Subtitle => ({
  id: '1',
  startEndTime: '',
  content: [source],
  sourceContent: source,
  targetContent: target,
  startTimeInSeconds: start,
  endTimeInSeconds: end,
});
const term = {
  id: 't',
  source: 'API',
  target: '接口',
  glossaryId: 'g',
  glossaryName: 'Terms',
  glossaryOrder: 0,
  entryOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const run = (rows: Subtitle[], extra = {}) =>
  checkQuality(
    { subtitles: rows, warnings: [], terms: [], translation: true, ...extra },
    new AbortController().signal,
  );
async function main() {
  assert.equal((await run([cue('hello', '')]))[0].kind, 'translation');
  assert.equal(
    (await run([cue('hello', '')], { translation: false })).length,
    0,
  );
  assert.equal(
    (
      await run([cue('一二三四五六七八九', '', 0, 1)], {
        translation: false,
        sourceLanguage: 'zh',
      })
    )[0].kind,
    'speed',
  );
  assert.equal(
    (
      await run([cue('e\u0301'.repeat(20), '', 0, 1)], {
        translation: false,
        sourceLanguage: 'en',
      })
    ).length,
    0,
  );
  assert.equal(
    (await run([cue('hello', 'good', 0, 1.1)], { duration: 1 })).length,
    0,
  );
  assert.equal(
    (await run([cue('hello', 'good', 0, 1.101)], { duration: 1 }))[0].detail
      .reason,
    'outside',
  );
  const overlap = await run([cue('one', '', 1, 3), cue('two', '', 2, 4)], {
    translation: false,
  });
  assert.equal(overlap[0].more, true);
  assert.equal(
    (await run([cue('API works', '它工作正常')], { terms: [term] }))[0].kind,
    'glossary',
  );
  assert.equal(
    (
      await run([cue('API works', '它工作正常'), cue('well', '接口', 3, 5)], {
        terms: [term],
      })
    ).length,
    0,
  );
  assert.equal(
    (await run([cue('APIs work', '它工作正常')], { terms: [term] })).length,
    0,
  );
  assert.equal(
    (await run([cue('ＡＰＩ works', '接口正常')], { terms: [term] })).length,
    0,
  );
  const warning = {
    id: 'w',
    startMs: 10000,
    endMs: 12000,
    level: 'high',
    signals: ['speechReview'],
    cueIds: [],
  };
  const gap = (await run([cue('hello')], { warnings: [warning] }))[0];
  assert.equal(gap.kind, 'speech');
  assert.deepEqual(gap.indices, []);
  const original = [cue('hello', '')],
    issues = await run(original);
  const state = emptyQualityReview();
  state.catalog = issues;
  state.decisions[issues[0].key] = {
    evidence: issues[0].evidence,
    status: 'confirmed',
  };
  const shifted = await run([
    cue('earlier', 'yes', 0, 0.8),
    { ...original[0], id: '2' },
  ]);
  assert.equal(
    qualityStatus(issues[0], new Map(shifted.map((i) => [i.key, i])), state),
    'confirmed',
  );
  const edited = await run([{ ...original[0], sourceContent: 'changed' }]);
  assert.equal(
    qualityStatus(issues[0], new Map(edited.map((i) => [i.key, i])), state),
    'pending',
  );
  assert.deepEqual(
    locateQualityIssue(issues[0], [original[0], original[0]]),
    [],
    'ambiguous rows are never applied',
  );
  const cache = createQualityCheckCache();
  const cachedInput = {
    subtitles: [cue('API works', '服务'), cue('hello', '好', 3, 5)],
    warnings: [],
    terms: [term],
    translation: true,
  };
  assert.equal(
    (await checkQuality(cachedInput, new AbortController().signal, cache))
      .length,
    1,
  );
  cachedInput.subtitles = [
    cachedInput.subtitles[0],
    { ...cachedInput.subtitles[1], targetContent: '接口' },
  ];
  assert.equal(
    (await checkQuality(cachedInput, new AbortController().signal, cache))
      .length,
    0,
    'neighbor translation invalidates cached glossary findings',
  );
  cachedInput.terms = [{ ...term, target: '应用接口' }];
  assert.equal(
    (await checkQuality(cachedInput, new AbortController().signal, cache))
      .length,
    1,
    'edited term invalidates cached matches',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-review-test-'));
  try {
    const store = createQualityReviewStore(dir),
      key = 'smartsub_proofread_draft_v1:["fixture"]';
    store.save(key, state);
    assert.deepEqual(store.read(key), state);
    assert.throws(() => store.save('../bad', state));
    assert.throws(() => store.save(key, { version: 99 }));
    assert.deepEqual(
      store.read(key),
      state,
      'failed save leaves previous data intact',
    );
    const roundTripRow = cue(
      'API works',
      'A translation that exceeds the reading speed threshold.',
      1,
      2,
    );
    const confirmedIssues = await run(
      [{ ...roundTripRow, translationStatus: 'success' }],
      { terms: [term] },
    );
    const confirmedState = {
      ...emptyQualityReview(),
      catalog: confirmedIssues,
      decisions: Object.fromEntries(
        confirmedIssues.map((i) => [
          i.key,
          { evidence: i.evidence, status: 'confirmed' as const },
        ]),
      ),
    };
    store.save(key, confirmedState);
    const reopened = await run([roundTripRow], { terms: [term] });
    const reopenedMap = new Map(reopened.map((i) => [i.key, i]));
    assert.ok(confirmedIssues.some((i) => i.kind === 'glossary'));
    assert.ok(confirmedIssues.some((i) => i.kind === 'speed'));
    for (const issue of confirmedIssues)
      assert.equal(
        qualityStatus(issue, reopenedMap, store.read(key)),
        'confirmed',
        'SRT roundtrip preserves decisions',
      );
    const denseRows = Array.from({ length: 10000 }, (_, i) =>
      cue('a b c d e f', 'Translation', i * 3, i * 3 + 2),
    );
    const denseTerms = ['a', 'b', 'c', 'd', 'e', 'f'].map((source) => ({
      ...term,
      source,
    }));
    const denseIssues = await run(denseRows, { terms: denseTerms });
    assert.equal(denseIssues.length, 60000);
    const dense = {
      ...emptyQualityReview(),
      catalog: mergeQualityCatalog([], denseIssues),
    };
    assert.equal(
      dense.catalog.length,
      60000,
      'all current findings remain visible',
    );
    dense.decisions[denseIssues[0].key] = {
      evidence: denseIssues[0].evidence,
      status: 'confirmed',
    };
    dense.insertionDrafts = {
      gap: { start: '0', end: '1', source: 'Keep draft', target: '' },
    };
    assert.doesNotThrow(
      () => store.save(key, dense),
      'generated catalogs must always be savable',
    );
    assert.ok(
      store.read(key).catalog.length <= 50000,
      'derived persisted catalog is bounded',
    );
    assert.ok(
      parseQualityReview(dense).catalog.length <= 50000,
      'legacy oversized metadata is compacted',
    );
    assert.deepEqual(store.read(key).decisions, dense.decisions);
    assert.deepEqual(store.read(key).insertionDrafts, dense.insertionDrafts);
    assert.ok(
      mergeQualityCatalog(denseIssues, [], denseIssues[0].key).length <= 5000,
      'retired history cannot grow indefinitely',
    );
    assert.ok(
      mergeQualityCatalog(denseIssues, [], denseIssues[0].key).some(
        (i) => i.key === denseIssues[0].key,
      ),
      'active retired issue stays pinned',
    );
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{bad');
    assert.throws(
      () => store.read(key),
      'bad saved progress is not silently reset',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rows = Array.from({ length: 10000 }, (_, i) =>
    cue(`term${i % 500} speaks.`, 'Translation.', i * 3, i * 3 + 2),
  );
  const terms = Array.from({ length: 500 }, (_, i) => ({
    ...term,
    id: `t${i}`,
    source: `term${i}`,
  }));
  const before = performance.now();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const result = await run(rows, { terms });
  clearInterval(timer);
  console.log(
    JSON.stringify({
      rows: rows.length,
      terms: terms.length,
      issues: result.length,
      elapsedMs: performance.now() - before,
      eventLoopTicks: ticks,
    }),
  );
  assert.ok(ticks > 0, 'checks yield to UI');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    checkQuality(
      { subtitles: rows, terms, warnings: [], translation: true },
      abort.signal,
    ),
    /CANCELLED/,
  );
  console.log(
    'Quality rules, Unicode, glossary boundaries, identity, storage and cancellation passed.',
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
