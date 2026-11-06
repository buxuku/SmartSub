import {
  DUMP_CLOCK_SLACK_MS,
  FAMILY_KEY,
  WEAK_STRIKE_LIMIT,
  adoptGpu,
  candidateKey,
  emptyBreaker,
  findSuppression,
  fingerprintHolds,
  isFamilyKey,
  parseBreaker,
  pruneBreaker,
  recordSuccess,
  reconcileBreaker,
  usesGpu,
  type BreakerEnv,
  type BreakerTable,
} from '../../main/helpers/crash/breaker';
import { classifyExit } from '../../main/helpers/crash/exitClassifier';
import type {
  NewDumpEvidence,
  PreviousRunAssessment,
} from '../../main/helpers/crash/previousRun';
import type { InFlightMark } from '../../main/helpers/crash/runState';
import { assert, finish, test } from './testkit';

const NOW = 1_000_000;
const ADDON_VULKAN = '/app/addons/addon.vulkan.node';
const ADDON_CPU = '/app/addons/addon.node';

type Files = Record<string, { size: number; mtimeMs: number }>;

function makeEnv(extra: Partial<BreakerEnv> = {}, files?: Files): BreakerEnv {
  const table: Files = files ?? {
    [ADDON_VULKAN]: { size: 100, mtimeMs: 5000 },
    [ADDON_CPU]: { size: 200, mtimeMs: 6000 },
  };
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Intel Core i7-3770',
    osRelease: '10.0.22631',
    appVersion: '2.2.0',
    statFile: (p) => table[p] ?? null,
    ...extra,
  };
}

function mark(extra: Partial<InFlightMark> = {}): InFlightMark {
  return {
    callId: 'c1',
    engine: 'whisper',
    backend: 'vulkan',
    candidateKey: 'builtin:vulkan',
    candidatePath: ADDON_VULKAN,
    startedAt: NOW - 5000,
    ...extra,
  };
}

function dump(
  mtimeMs: number,
  windowsCode: number | null = 0xc0000005,
): NewDumpEvidence {
  return {
    file: `/d/${mtimeMs}.dmp`,
    name: `${mtimeMs}.dmp`,
    mtimeMs,
    summary: null,
    classification:
      windowsCode === null
        ? null
        : classifyExit({
            platform: 'win32',
            exitCode: windowsCode,
            reason: 'crashed',
          }),
  };
}

function abnormal(
  inFlight: InFlightMark[],
  newDumps: NewDumpEvidence[] = [],
): Pick<PreviousRunAssessment, 'status' | 'inFlight' | 'newDumps'> {
  return { status: 'abnormal', inFlight, newDumps };
}

function reconcile(
  table: BreakerTable,
  assessment: ReturnType<typeof abnormal>,
  env = makeEnv(),
) {
  return reconcileBreaker(table, assessment, env, NOW);
}

async function main() {
  await test('候选键：来源:后端[:变体]，不含路径；custom 不属于预编译族', () => {
    assert.equal(candidateKey('builtin', 'vulkan', 'vulkan'), 'builtin:vulkan');
    assert.equal(
      candidateKey('userData', 'cuda', '12.4.0'),
      'userData:cuda:12.4.0',
    );
    assert.equal(candidateKey('builtin', 'cpu', null), 'builtin:cpu');
    assert.equal(candidateKey('custom', 'custom'), 'custom:custom');
    assert.equal(isFamilyKey('builtin:cpu'), true);
    assert.equal(isFamilyKey('userData:cuda:12.4.0'), true);
    assert.equal(isFamilyKey('custom:custom'), false);
    assert.equal(usesGpu('builtin:vulkan'), true);
    assert.equal(usesGpu('userData:cuda:12.4.0'), true);
    assert.equal(usesGpu('builtin:cpu'), false);
    assert.equal(usesGpu('builtin:metal'), false);
    assert.equal(usesGpu('custom:custom'), false);
  });

  await test('强证据：在途标记 + 其后产生的转储，一次就抑制该候选', () => {
    const { table, changes } = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000)]),
    );
    assert.equal(table.suppressions.length, 1);
    const s = table.suppressions[0];
    assert.equal(s.scope, 'candidate');
    assert.equal(s.key, 'builtin:vulkan');
    assert.equal(s.reason, 'crash');
    assert.equal(s.evidence, 'strong');
    assert.deepEqual(table.strikes, []);
    assert.equal(changes[0].kind, 'suppressed');
    // 抑制记录的指纹：CPU、系统版本、addon 文件；候选级不绑定应用版本
    assert.deepEqual(s.fingerprint, {
      cpuModel: 'Intel Core i7-3770',
      osRelease: '10.0.22631',
      addon: { path: ADDON_VULKAN, size: 100, mtimeMs: 5000 },
    });
    assert.match(s.detail ?? '', /access-violation/);
    // 只抑制它自己，不牵连别的候选
    assert.ok(findSuppression(table, 'builtin:vulkan', makeEnv()));
    assert.equal(findSuppression(table, 'builtin:cpu', makeEnv()), null);
  });

  await test('非法指令（x64 预编译包）：整族一并抑制，vulkan、cuda、cpu 都不再加载；custom 不受影响', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000, 0xc000001d)]),
    );
    assert.equal(table.suppressions.length, 1);
    const s = table.suppressions[0];
    assert.equal(s.scope, 'family');
    assert.equal(s.key, FAMILY_KEY);
    assert.equal(s.reason, 'isa');
    assert.match(s.detail ?? '', /illegal-instruction/);
    assert.match(s.detail ?? '', /0xC000001D/);
    // 族级指纹：CPU 型号 + 应用版本 + 触发崩溃的 addon；不含系统版本
    assert.equal(s.fingerprint.osRelease, undefined);
    assert.equal(s.fingerprint.appVersion, '2.2.0');
    assert.equal(s.fingerprint.cpuModel, 'Intel Core i7-3770');

    const env = makeEnv();
    for (const key of [
      'builtin:vulkan',
      'builtin:cpu',
      'userData:cuda:12.4.0',
      'userData:vulkan',
    ]) {
      assert.equal(findSuppression(table, key, env)?.scope, 'family', key);
    }
    assert.equal(findSuppression(table, 'custom:custom', env), null);
    // arm64 上族级抑制不适用（那是 x64 预编译包的问题）
    assert.equal(
      findSuppression(table, 'builtin:metal', makeEnv({ arch: 'arm64' })),
      null,
    );
  });

  await test('非法指令但不是 x64 预编译包：只抑制该候选，原因记为 isa', () => {
    const arm = reconcile(
      emptyBreaker(),
      abnormal(
        [mark({ candidateKey: 'builtin:metal', backend: 'metal' })],
        [dump(NOW - 1000, 0xc000001d)],
      ),
      makeEnv({ arch: 'arm64' }),
    ).table;
    assert.equal(arm.suppressions[0].scope, 'candidate');
    assert.equal(arm.suppressions[0].reason, 'isa');

    const custom = reconcile(
      emptyBreaker(),
      abnormal(
        [mark({ candidateKey: 'custom:custom', backend: 'custom' })],
        [dump(NOW - 1000, 0xc000001d)],
      ),
    ).table;
    assert.equal(custom.suppressions[0].scope, 'candidate');
    assert.equal(custom.suppressions[0].key, 'custom:custom');
    // 用户自己的 addon 崩了，不能因此把预编译包也停掉
    assert.equal(findSuppression(custom, 'builtin:cpu', makeEnv()), null);
  });

  await test('弱证据：只有在途标记没有转储，第 1 次只计数，连续第 2 次才抑制', () => {
    const first = reconcile(emptyBreaker(), abnormal([mark()]));
    assert.deepEqual(first.table.suppressions, []);
    assert.equal(first.table.strikes.length, 1);
    assert.equal(first.table.strikes[0].count, 1);
    assert.deepEqual(first.changes, [
      { kind: 'strike', key: 'builtin:vulkan', count: 1 },
    ]);
    assert.equal(WEAK_STRIKE_LIMIT, 2);

    const second = reconcile(first.table, abnormal([mark({ callId: 'c2' })]));
    assert.equal(second.table.suppressions.length, 1);
    assert.equal(second.table.suppressions[0].evidence, 'weak');
    assert.equal(second.table.suppressions[0].reason, 'crash');
    assert.deepEqual(second.table.strikes, []);
  });

  await test('弱证据计数在一次成功调用后清零；成功的是别的候选则不影响', () => {
    const first = reconcile(emptyBreaker(), abnormal([mark()])).table;
    assert.equal(recordSuccess(first, 'builtin:cpu'), first);
    const cleared = recordSuccess(first, 'builtin:vulkan');
    assert.deepEqual(cleared.strikes, []);
    // 清零后再来一次又是第 1 次
    const again = reconcile(cleared, abnormal([mark()]));
    assert.deepEqual(again.table.suppressions, []);
    assert.equal(again.table.strikes[0].count, 1);
  });

  await test('转储早于在途标记开始：不算这次崩溃的证据（退化为弱证据）', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 5000 - 2001)]),
    );
    assert.deepEqual(table.suppressions, []);
    assert.equal(table.strikes.length, 1);
  });

  await test('时间精度余量：转储的 mtime 比标记早 2 秒以内（FAT 精度）仍算强证据', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 5000 - 1999)]),
    );
    assert.equal(table.suppressions.length, 1);
    assert.equal(table.suppressions[0].evidence, 'strong');
    assert.equal(DUMP_CLOCK_SLACK_MS, 2000);
  });

  await test('转储解读不出来也算有转储：强证据，原因为 crash，没有 detail', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000, null)]),
    );
    assert.equal(table.suppressions[0].evidence, 'strong');
    assert.equal(table.suppressions[0].reason, 'crash');
    assert.equal(table.suppressions[0].detail, undefined);
  });

  await test('只处理 whisper 的标记：其他引擎、没有候选键的标记一律忽略', () => {
    const { table, changes } = reconcile(
      emptyBreaker(),
      abnormal(
        [
          mark({ engine: 'sherpa-tts' }),
          mark({ callId: 'x', candidateKey: undefined }),
        ],
        [dump(NOW - 1000)],
      ),
    );
    assert.deepEqual(table, emptyBreaker());
    assert.deepEqual(changes, []);
  });

  await test('dlopen 阶段的标记同样生效（engine 为 whisper-load）', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal(
        [mark({ engine: 'whisper-load', phase: 'dlopen' })],
        [dump(NOW - 1000, 0xc000001d)],
      ),
    );
    assert.equal(table.suppressions[0].scope, 'family');
  });

  await test('上次不是异常退出：不并入新证据（但失效的旧记录照样清理）', () => {
    for (const status of ['clean', 'unknown'] as const) {
      const { table } = reconcileBreaker(
        emptyBreaker(),
        { status, inFlight: [mark()], newDumps: [dump(NOW)] },
        makeEnv(),
        NOW,
      );
      assert.deepEqual(table, emptyBreaker());
    }
  });

  await test('整族已被抑制时，同一次里别的族成员的标记不再重复记录', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal(
        [
          mark(),
          mark({
            callId: 'c2',
            candidateKey: 'builtin:cpu',
            candidatePath: ADDON_CPU,
          }),
        ],
        [dump(NOW - 1000, 0xc000001d)],
      ),
    );
    assert.equal(table.suppressions.length, 1);
    assert.equal(table.suppressions[0].scope, 'family');
  });

  await test('并发的两次调用同时在途：各自按自己的候选记录', () => {
    const { table } = reconcile(
      emptyBreaker(),
      abnormal(
        [
          mark(),
          mark({
            callId: 'c2',
            candidateKey: 'userData:cuda:12.4.0',
            backend: 'cuda',
            candidatePath: ADDON_CPU,
          }),
        ],
        [dump(NOW - 1000)],
      ),
    );
    assert.deepEqual(table.suppressions.map((s) => s.key).sort(), [
      'builtin:vulkan',
      'userData:cuda:12.4.0',
    ]);
  });

  await test('指纹失效（候选级）：CPU 型号、系统版本、addon 大小或修改时间、addon 被删，任一变化都解除抑制', () => {
    const base = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000)]),
    ).table;
    const held = (env: BreakerEnv) =>
      findSuppression(pruneBreaker(base, env).table, 'builtin:vulkan', env) !==
      null;

    assert.equal(held(makeEnv()), true);
    assert.equal(held(makeEnv({ cpuModel: 'AMD Ryzen 7 5800X' })), false);
    assert.equal(held(makeEnv({ osRelease: '10.0.26100' })), false);
    // 应用版本不影响候选级抑制（addon 文件没变就还是同一个东西）
    assert.equal(held(makeEnv({ appVersion: '2.3.0' })), true);
    assert.equal(
      held(
        makeEnv(
          {},
          {
            [ADDON_VULKAN]: { size: 101, mtimeMs: 5000 },
            [ADDON_CPU]: { size: 1, mtimeMs: 1 },
          },
        ),
      ),
      false,
    );
    assert.equal(
      held(makeEnv({}, { [ADDON_VULKAN]: { size: 100, mtimeMs: 5001 } })),
      false,
    );
    assert.equal(held(makeEnv({}, {})), false);
  });

  await test('指纹失效（族级）：换 CPU 或升级应用后重新尝试；换系统版本不影响', () => {
    const base = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000, 0xc000001d)]),
    ).table;
    const held = (env: BreakerEnv) =>
      findSuppression(pruneBreaker(base, env).table, 'builtin:cpu', env) !==
      null;
    assert.equal(held(makeEnv()), true);
    assert.equal(held(makeEnv({ osRelease: '10.0.26100' })), true);
    assert.equal(held(makeEnv({ cpuModel: 'Intel Core i9-13900K' })), false);
    assert.equal(held(makeEnv({ appVersion: '2.3.0' })), false);
  });

  await test('弱证据计数同样受指纹约束：addon 更新后重新计数', () => {
    const first = reconcile(emptyBreaker(), abnormal([mark()])).table;
    const updated = makeEnv(
      {},
      { [ADDON_VULKAN]: { size: 999, mtimeMs: 9000 } },
    );
    const { table, changes } = reconcileBreaker(
      first,
      abnormal([mark({ callId: 'c2' })]),
      updated,
      NOW,
    );
    assert.deepEqual(table.suppressions, []);
    assert.equal(table.strikes.length, 1);
    assert.equal(table.strikes[0].count, 1);
    assert.ok(changes.some((c) => c.kind === 'dropped' && c.what === 'strike'));
  });

  await test('显卡指纹：启动时没有，加载时补上；之后显卡或驱动变了才失效', () => {
    const base = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000)]),
    ).table;
    assert.equal(base.suppressions[0].fingerprint.gpu, undefined);
    // 还不知道显卡时不下结论：保持
    assert.equal(
      fingerprintHolds(base.suppressions[0].fingerprint, makeEnv()),
      true,
    );

    const adopted = adoptGpu(base, 'NVIDIA GeForce GTX 1060@551.23');
    assert.equal(
      adopted.suppressions[0].fingerprint.gpu,
      'NVIDIA GeForce GTX 1060@551.23',
    );
    const env = (gpu: string) => makeEnv({ gpu });
    assert.equal(
      fingerprintHolds(
        adopted.suppressions[0].fingerprint,
        env('NVIDIA GeForce GTX 1060@551.23'),
      ),
      true,
    );
    assert.equal(
      fingerprintHolds(
        adopted.suppressions[0].fingerprint,
        env('NVIDIA GeForce GTX 1060@560.94'),
      ),
      false,
    );
    // 已经有指纹的不会被覆盖
    assert.equal(
      adoptGpu(adopted, 'other').suppressions[0].fingerprint.gpu,
      'NVIDIA GeForce GTX 1060@551.23',
    );
  });

  await test('补显卡指纹只补用得到显卡的候选（cpu、custom、族级不补）', () => {
    const cpu = reconcile(
      emptyBreaker(),
      abnormal(
        [mark({ candidateKey: 'builtin:cpu', candidatePath: ADDON_CPU })],
        [dump(NOW - 1000)],
      ),
    ).table;
    assert.equal(
      adoptGpu(cpu, 'gpu').suppressions[0].fingerprint.gpu,
      undefined,
    );
    const family = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000, 0xc000001d)]),
    ).table;
    assert.equal(
      adoptGpu(family, 'gpu').suppressions[0].fingerprint.gpu,
      undefined,
    );
  });

  await test('解析宽容：损坏的条目被丢弃，合格的保留；整体不是对象就当空表', () => {
    assert.deepEqual(parseBreaker(null), emptyBreaker());
    assert.deepEqual(parseBreaker('x'), emptyBreaker());
    assert.deepEqual(parseBreaker([]), emptyBreaker());
    const good = reconcile(
      emptyBreaker(),
      abnormal([mark()], [dump(NOW - 1000)]),
    ).table.suppressions[0];
    const parsed = parseBreaker({
      suppressions: [
        good,
        { ...good, scope: 'galaxy' },
        { ...good, reason: 'because' },
        { ...good, evidence: 'maybe' },
        { ...good, key: '' },
        { ...good, since: 'yesterday' },
        null,
        'oops',
      ],
      strikes: [
        { key: 'a', count: 1, lastAt: 1, fingerprint: {} },
        { key: 'b', count: 0, lastAt: 1 },
        { key: 'c', count: 'many', lastAt: 1 },
        { count: 1, lastAt: 1 },
      ],
    });
    assert.deepEqual(parsed.suppressions, [good]);
    assert.deepEqual(
      parsed.strikes.map((s) => s.key),
      ['a'],
    );
    // 往返不丢信息
    assert.deepEqual(parseBreaker(JSON.parse(JSON.stringify(parsed))), parsed);
  });

  await test('指纹里损坏的字段被忽略，不会让整条记录失效或崩溃', () => {
    const parsed = parseBreaker({
      suppressions: [
        {
          scope: 'candidate',
          key: 'builtin:vulkan',
          reason: 'crash',
          evidence: 'strong',
          since: 1,
          fingerprint: {
            cpuModel: 5,
            osRelease: 'x',
            addon: { path: 'p', size: 'big', mtimeMs: 1 },
          },
        },
      ],
    });
    assert.deepEqual(parsed.suppressions[0].fingerprint, { osRelease: 'x' });
  });

  finish('breaker');
}

main();
