import { buildCrashSnapshot } from '../../main/helpers/crash/crashSnapshot';
import {
  assessPreviousRun,
  type PreviousRunAssessment,
} from '../../main/helpers/crash/previousRun';
import {
  bufferSource,
  summarizeMinidump,
} from '../../main/helpers/crash/minidumpSummary';
import { RUN_STATE_VERSION } from '../../main/helpers/crash/runState';
import type { BreakerSnapshot } from '../../main/helpers/crash/nativeGuard';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

const STARTED = 10_000;

function assessmentWithDump(): PreviousRunAssessment {
  const dump = buildMinidump({
    os: 'windows',
    cpu: { family: 6, model: 58, stepping: 9 },
    modules: [
      { name: 'C:\\app\\addon.vulkan.node', base: 0x1000n, size: 0x1000 },
    ],
    exception: { code: 0xc000001d, address: 0x1800n },
  });
  const summary = summarizeMinidump(bufferSource(dump));
  assert.ok(summary);
  return assessPreviousRun({
    previous: {
      version: RUN_STATE_VERSION,
      cleanExit: false,
      startedAt: STARTED,
      appVersion: '2.1.0',
      inFlight: [
        {
          callId: 'c1',
          engine: 'whisper-builtin',
          backend: 'vulkan',
          candidateKey: 'builtin:vulkan',
          model: 'ggml-base.bin',
          phase: 'transcribe',
          startedAt: STARTED + 1000,
        },
      ],
      breaker: { suppressions: [], strikes: [] },
    },
    now: 50_000,
    dumps: [{ file: '/d/new.dmp', size: 99, mtimeMs: STARTED + 5000 }],
    summarize: () => summary,
    events: [],
    appVersion: '2.2.0',
    platform: 'win32',
    arch: 'x64',
  });
}

const BREAKER: BreakerSnapshot = {
  enabled: true,
  suppressions: [
    {
      scope: 'family',
      key: 'whisper-x64-prebuilt',
      reason: 'isa',
      evidence: 'strong',
      since: 1,
      fingerprint: { cpuModel: 'Old CPU', appVersion: '2.2.0' },
      detail: 'illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)',
    },
  ],
  strikes: [],
};

async function main() {
  await test('熔断表与上次运行的结局一并进入快照，转储只留排查用的几个字段', () => {
    const snapshot = buildCrashSnapshot(BREAKER, assessmentWithDump());

    assert.equal(snapshot.crashBreaker.enabled, true);
    assert.equal(
      snapshot.crashBreaker.suppressions[0].key,
      'whisper-x64-prebuilt',
    );
    assert.equal(snapshot.previousRun?.status, 'abnormal');
    assert.deepEqual(snapshot.previousRun?.evidence, ['dump', 'in-flight']);
    assert.equal(
      snapshot.previousRun?.inFlight[0].candidateKey,
      'builtin:vulkan',
    );
    assert.deepEqual(snapshot.previousRun?.newDumps, [
      {
        name: 'new.dmp',
        mtimeMs: STARTED + 5000,
        exception: 'ILLEGAL_INSTRUCTION',
        faultModule: 'addon.vulkan.node',
        kind: 'illegal-instruction',
      },
    ]);
  });

  await test('快照能直接 JSON 化：转储摘要里的 BigInt 等内容不会带进来', () => {
    const snapshot = buildCrashSnapshot(BREAKER, assessmentWithDump());
    const text = JSON.stringify(snapshot);
    assert.ok(text.length > 0);
    // 摘要的模块表、CPU 信息等不属于这一段（system.json 与 crash/ 目录里已有）
    assert.ok(!text.includes('"modules"'));
    assert.ok(!text.includes('"cpu"'));
  });

  await test('没有上次运行的记录时 previousRun 为 null，熔断表照常给出', () => {
    const snapshot = buildCrashSnapshot(
      { enabled: false, suppressions: [], strikes: [] },
      null,
    );
    assert.equal(snapshot.previousRun, null);
    assert.equal(snapshot.crashBreaker.enabled, false);
  });

  await test('读不出摘要的转储也有一行，字段为 null 而不是缺失', () => {
    const assessment = assessmentWithDump();
    assessment.newDumps = [
      {
        file: '/d/odd.dmp',
        name: 'odd.dmp',
        mtimeMs: 5,
        summary: null,
        classification: null,
      },
    ];
    const snapshot = buildCrashSnapshot(BREAKER, assessment);
    assert.deepEqual(snapshot.previousRun?.newDumps, [
      {
        name: 'odd.dmp',
        mtimeMs: 5,
        exception: null,
        faultModule: null,
        kind: null,
      },
    ]);
  });

  finish('crash-snapshot');
}

void main();
