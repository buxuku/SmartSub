'use strict';
/**
 * extraResources/sherpa/worker/segment-split.js 的单元测试（纯 Node，不需要原生库）。
 * openspec split-qwen-asr-long-segments design D2：超长 VAD 段按「最安静的帧」切成不超过上限的几片。
 * 运行：node scripts/test-segment-split.cjs（已并入 yarn test:engines）
 */
const assert = require('node:assert/strict');
const {
  splitSegment,
} = require('../extraResources/sherpa/worker/segment-split.js');

const SR = 16000;
const FRAME = 320; // 20 ms @ 16 kHz

/** 可复现的伪随机数（mulberry32）。 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 振幅 0.3 的噪声；`valleys`（[起秒, 止秒, 振幅]）内换成更安静的噪声。 */
function noise(seconds, valleys = [], seed = 1) {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SR;
    const valley = valleys.find(([from, to]) => t >= from && t < to);
    out[i] = (rand() * 2 - 1) * (valley ? valley[2] : 0.3);
  }
  return out;
}

/** 起伏的类语音信号：每 100 ms 换一个振幅，约两成为静音。 */
function speechLike(seconds, seed) {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  let amplitude = 0.2;
  for (let i = 0; i < out.length; i += 1) {
    if (i % (SR / 10) === 0) {
      amplitude = rand() < 0.2 ? 0 : 0.05 + 0.25 * rand();
    }
    out[i] = (rand() * 2 - 1) * amplitude;
  }
  return out;
}

/** 通用不变量：首尾相接、覆盖整段、片非空、不超过上限。返回各切点（样本下标）。 */
function checkPieces(pieces, total, limitSeconds, label, rate = SR) {
  assert.equal(pieces[0].start, 0, `${label}: first piece starts at 0`);
  assert.equal(
    pieces.at(-1).end,
    total,
    `${label}: last piece ends at the segment end`,
  );
  const maxLen = Math.floor(limitSeconds * rate);
  pieces.forEach((piece, i) => {
    const length = piece.end - piece.start;
    assert.ok(length > 0, `${label}: piece ${i} is not empty`);
    assert.ok(
      length <= maxLen,
      `${label}: piece ${i} has ${length} samples, over ${maxLen}`,
    );
    if (i > 0) {
      assert.equal(
        piece.start,
        pieces[i - 1].end,
        `${label}: piece ${i} follows piece ${i - 1} without gap or overlap`,
      );
    }
  });
  return pieces.slice(1).map((piece) => piece.start);
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test('a segment that fits the limit is returned whole', () => {
  for (const seconds of [5, 19.9, 20]) {
    const samples = noise(seconds);
    assert.deepEqual(
      splitSegment(samples, SR, 20),
      [{ start: 0, end: samples.length }],
      `${seconds}s`,
    );
  }
});

test('a 56 s segment becomes 4 pieces of at most 20 s covering it exactly', () => {
  const samples = noise(56);
  const pieces = splitSegment(samples, SR, 20);
  assert.equal(pieces.length, 4);
  checkPieces(pieces, samples.length, 20, '56s');
});

test('the piece count follows ceil(d / (L - 2r)) at the boundaries', () => {
  // L = 20, r = 2: L - 2r = 16
  for (const [seconds, count] of [
    [20.01, 2],
    [32, 2],
    [32.01, 3],
    [48, 3],
    [100, 7],
  ]) {
    const samples = new Float32Array(Math.round(seconds * SR));
    assert.equal(splitSegment(samples, SR, 20).length, count, `${seconds}s`);
  }
});

test('cuts land in quiet valleys near the ideal positions', () => {
  // ideal cuts at 14 / 28 / 42 s; each valley is inside the +-2 s window, off-centre
  const valleys = [
    [12.9, 13.3, 0],
    [29.4, 29.8, 0],
    [41.0, 41.4, 0],
  ];
  const samples = noise(56, valleys);
  const cuts = checkPieces(
    splitSegment(samples, SR, 20),
    samples.length,
    20,
    'valleys',
  );
  assert.equal(cuts.length, 3);
  cuts.forEach((cut, i) => {
    const [from, to] = valleys[i];
    assert.ok(
      cut >= from * SR && cut <= to * SR,
      `cut ${i + 1} at ${(cut / SR).toFixed(2)}s is inside the ${from}-${to}s valley`,
    );
  });
});

test('the search stays inside +-2 s of the ideal cut', () => {
  // The zero valley at 17.2-17.6 s is 3.2 s past the ideal 14 s: out of reach.
  // The shallow valley at 12.6-12.9 s is inside the window and must win.
  const samples = noise(56, [
    [12.6, 12.9, 0.01],
    [17.2, 17.6, 0],
  ]);
  const cuts = checkPieces(
    splitSegment(samples, SR, 20),
    samples.length,
    20,
    'window',
  );
  assert.ok(
    cuts[0] >= 12.6 * SR && cuts[0] <= 12.9 * SR,
    `first cut at ${(cuts[0] / SR).toFixed(2)}s is in the shallow valley`,
  );
  cuts.forEach((cut, i) => {
    const ideal = (i + 1) * 14 * SR;
    assert.ok(
      Math.abs(cut - ideal) <= 2 * SR,
      `cut ${i + 1} stays within 2 s of ${ideal / SR}s`,
    );
  });
});

test('a flat signal splits evenly', () => {
  for (const fill of [0, 0.1]) {
    const samples = new Float32Array(56 * SR).fill(fill);
    const cuts = checkPieces(
      splitSegment(samples, SR, 20),
      samples.length,
      20,
      `flat ${fill}`,
    );
    cuts.forEach((cut, i) => {
      const ideal = ((i + 1) * samples.length) / 4;
      assert.ok(
        Math.abs(cut - ideal) <= FRAME / 2,
        `flat ${fill}: cut ${i + 1} is within half a frame of an equal split`,
      );
    });
  }
});

test('one quiet notch is never used for two cuts when the limit is small', () => {
  // L = 8.6 s, d = 10 s. With a search radius of L/4 (r = 2 s) the windows of two neighbouring
  // cuts overlap, both would pick the notch (three silent frames, one unique quietest frame
  // after smoothing) and leave an empty piece between them.
  const samples = noise(10, [[4.96, 5.02, 0]]);
  const pieces = splitSegment(samples, SR, 8.6);
  const cuts = checkPieces(pieces, samples.length, 8.6, 'notch');
  assert.ok(
    cuts.some((cut) => cut >= 4.96 * SR && cut <= 5.02 * SR),
    'a cut still uses the notch',
  );
});

test('the sample rate argument is honoured', () => {
  const samples = new Float32Array(56 * 8000);
  const pieces = splitSegment(samples, 8000, 20);
  assert.equal(pieces.length, 4);
  checkPieces(pieces, samples.length, 20, '8 kHz', 8000);
});

test('limits that are absent, non-finite, non-positive or under 1 s leave the segment whole', () => {
  const samples = new Float32Array(56 * SR);
  for (const limit of [
    undefined,
    null,
    0,
    -3,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '20',
    0.99,
  ]) {
    assert.deepEqual(
      splitSegment(samples, SR, limit),
      [{ start: 0, end: samples.length }],
      `limit ${String(limit)}`,
    );
  }
});

test('invariants hold across limits and durations', () => {
  let cases = 0;
  for (const limit of [1, 2.5, 8.6, 12, 15, 20]) {
    const r = Math.min(2, limit / 6);
    // d/n > (L - 2r)/2 and each cut moves at most r, so a piece is at least (L - 2r)/2 - 2r long
    const guaranteedMin = Math.max(0, (limit - 2 * r) / 2 - 2 * r) * SR - 4;
    for (const factor of [1.01, 1.5, 2, 2.7, 3.3, 5]) {
      cases += 1;
      const seconds = limit * factor;
      const samples = speechLike(seconds, cases);
      const label = `limit ${limit}s, ${seconds.toFixed(2)}s`;
      const pieces = splitSegment(samples, SR, limit);
      checkPieces(pieces, samples.length, limit, label);
      assert.ok(
        pieces.length >= Math.ceil(samples.length / Math.floor(limit * SR)),
        `${label}: not fewer pieces than the limit requires`,
      );
      pieces.forEach((piece, i) =>
        assert.ok(
          piece.end - piece.start >= guaranteedMin,
          `${label}: piece ${i} is not a sliver`,
        ),
      );
    }
  }
  assert.equal(cases, 36);
});

console.log(`segment-split: ${passed} tests passed`);
