import {
  assessPreviousRun,
  type AssessPreviousRunInput,
} from '../../main/helpers/crash/previousRun';
import type { CrashEvent } from '../../main/helpers/crash/crashEvents';
import { buildClassification } from '../../main/helpers/crash/exitClassifier';
import {
  bufferSource,
  summarizeMinidump,
  type MinidumpSummary,
} from '../../main/helpers/crash/minidumpSummary';
import {
  RUN_STATE_VERSION,
  type InFlightMark,
  type RunState,
} from '../../main/helpers/crash/runState';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

const STARTED = 10_000;
const NOW = 50_000;

function previous(extra: Partial<RunState> = {}): RunState {
  return {
    version: RUN_STATE_VERSION,
    cleanExit: false,
    startedAt: STARTED,
    appVersion: '2.1.0',
    inFlight: [],
    ...extra,
  };
}

const MARK: InFlightMark = {
  callId: 'c1',
  engine: 'whisper-builtin',
  backend: 'vulkan',
  model: 'ggml-base.bin',
  phase: 'transcribe',
  startedAt: STARTED + 1000,
};

function summaryOf(
  code: number,
  os: 'windows' | 'linux' | 'macos' = 'windows',
): MinidumpSummary {
  const dump = buildMinidump({
    os,
    cpu: { family: 6, model: 58, stepping: 9 },
    modules: [
      { name: 'C:\\app\\addon.vulkan.node', base: 0x1000n, size: 0x1000 },
    ],
    exception: { code, address: 0x1800n },
  });
  const summary = summarizeMinidump(bufferSource(dump));
  assert.ok(summary);
  return summary;
}

function run(extra: Partial<AssessPreviousRunInput> = {}) {
  const summarized: string[] = [];
  const input: AssessPreviousRunInput = {
    previous: previous(),
    now: NOW,
    dumps: [],
    summarize: (file) => {
      summarized.push(file);
      return null;
    },
    events: [],
    appVersion: '2.2.0',
    platform: 'win32',
    arch: 'x64',
    ...extra,
  };
  return { result: assessPreviousRun(input), summarized };
}

function crashEvent(ts: number, extra: Partial<CrashEvent> = {}): CrashEvent {
  return {
    ts,
    source: 'child-process-gone',
    classification: buildClassification('access-violation', 'ACCESS_VIOLATION'),
    ...extra,
  };
}

async function main() {
  await test('没有上次的记录（首次运行或文件损坏）：状态未知，不提示、不写日志', () => {
    const { result, summarized } = run({ previous: null });
    assert.equal(result.status, 'unknown');
    assert.equal(result.notice, null);
    assert.equal(result.event, null);
    assert.equal(result.log, null);
    assert.deepEqual(summarized, []);
  });

  await test('上次正常退出：不找证据（不读转储），不提示——即使有新转储与崩溃事件', () => {
    const { result, summarized } = run({
      previous: previous({ cleanExit: true }),
      dumps: [{ file: '/d/a.dmp', size: 1, mtimeMs: NOW - 1 }],
      events: [crashEvent(NOW - 5)],
    });
    assert.equal(result.status, 'clean');
    assert.equal(result.notice, null);
    assert.equal(result.log, null);
    assert.deepEqual(summarized, []);
  });

  await test('异常结束但没有任何证据（强杀、安装程序关闭、断电）：只写一行 info 日志，不提示', () => {
    const { result } = run();
    assert.equal(result.status, 'abnormal');
    assert.deepEqual(result.evidence, []);
    assert.equal(result.notice, null);
    assert.equal(result.event, null);
    assert.equal(result.log?.level, 'info');
    assert.match(result.log?.message ?? '', /no crash evidence/);
  });

  await test('新转储 + Windows 非法指令：提示里带分类、故障模块；事件记为 previous-run', () => {
    const summary = summaryOf(0xc000001d);
    const { result } = run({
      dumps: [{ file: '/d/new.dmp', size: 99, mtimeMs: STARTED + 5000 }],
      summarize: (file) => {
        assert.equal(file, '/d/new.dmp');
        return summary;
      },
    });
    assert.deepEqual(result.evidence, ['dump']);
    assert.equal(result.notice?.kind, 'illegal-instruction');
    assert.equal(result.notice?.label, 'ILLEGAL_INSTRUCTION');
    assert.equal(result.notice?.faultModule, 'addon.vulkan.node');
    assert.equal(result.notice?.at, STARTED + 5000);
    assert.equal(result.log?.level, 'warning');
    assert.match(result.log?.message ?? '', /illegal-instruction/);
    assert.match(result.log?.message ?? '', /addon\.vulkan\.node/);

    const event = result.event;
    assert.equal(event?.source, 'previous-run');
    assert.equal(event?.ts, NOW);
    assert.equal(event?.classification?.isIsa, true);
    assert.match(event?.detail ?? '', /dump x1/);
    // 记的是崩溃那一版，不是当前版本
    assert.equal(event?.appVersion, '2.1.0');
    assert.equal(event?.platform, 'win32');
  });

  await test('比上次启动更早的转储是更早的崩溃，不算本次的证据', () => {
    const { result, summarized } = run({
      dumps: [
        { file: '/d/old.dmp', size: 1, mtimeMs: STARTED - 1 },
        { file: '/d/older.dmp', size: 1, mtimeMs: STARTED - 9999 },
      ],
    });
    assert.deepEqual(result.evidence, []);
    assert.equal(result.notice, null);
    assert.deepEqual(summarized, []);
  });

  await test('转储很多时只解读最新的 3 份', () => {
    const dumps = Array.from({ length: 6 }, (_, i) => ({
      file: `/d/${i}.dmp`,
      size: 1,
      mtimeMs: NOW - i, // 新的在前
    }));
    const { result, summarized } = run({ dumps });
    assert.deepEqual(summarized, ['/d/0.dmp', '/d/1.dmp', '/d/2.dmp']);
    assert.equal(result.newDumps.length, 3);
    // 解读不出来（null）也算有转储这条证据
    assert.deepEqual(result.evidence, ['dump']);
    assert.equal(result.notice?.kind, undefined);
  });

  await test('遗留的在途标记：提示里带引擎与后端；事件现场取最新的一条标记', () => {
    const older: InFlightMark = {
      ...MARK,
      callId: 'c0',
      engine: 'sherpa-tts',
      backend: undefined,
      startedAt: STARTED + 10,
    };
    const { result } = run({
      previous: previous({ inFlight: [older, MARK] }),
    });
    assert.deepEqual(result.evidence, ['in-flight']);
    assert.equal(result.notice?.engine, 'whisper-builtin');
    assert.equal(result.notice?.backend, 'vulkan');
    assert.equal(result.notice?.kind, undefined);
    assert.equal(result.notice?.at, MARK.startedAt);
    assert.deepEqual(
      result.event?.context?.map((c) => [
        c.engine,
        c.backend,
        c.model,
        c.phase,
      ]),
      [['whisper-builtin', 'vulkan', 'ggml-base.bin', 'transcribe']],
    );
    assert.match(result.event?.detail ?? '', /in-flight x2/);
  });

  await test('崩溃事件作证据：只算上次启动之后的、归为崩溃的，且不把 previous-run 自己算进去', () => {
    const { result } = run({
      events: [
        crashEvent(STARTED - 100), // 更早的
        crashEvent(STARTED + 100, {
          classification: buildClassification('clean', 'CLEAN'),
        }), // 不是崩溃
        crashEvent(STARTED + 200, { source: 'previous-run' }), // 自己写过的
        crashEvent(STARTED + 300, {
          context: [{ engine: 'sherpa-funasr', startedAt: STARTED + 250 }],
        }),
      ],
    });
    assert.deepEqual(result.evidence, ['event']);
    assert.equal(result.crashEvents.length, 1);
    assert.equal(result.notice?.kind, 'access-violation');
    assert.equal(result.notice?.engine, 'sherpa-funasr');
    assert.equal(result.notice?.at, STARTED + 300);
  });

  await test('多种证据同时存在：转储的分类优先于事件的；证据按 dump、in-flight、event 排序', () => {
    const { result } = run({
      previous: previous({ inFlight: [MARK] }),
      dumps: [{ file: '/d/n.dmp', size: 1, mtimeMs: STARTED + 9000 }],
      summarize: () => summaryOf(0xc000001d),
      events: [crashEvent(STARTED + 8000)],
    });
    assert.deepEqual(result.evidence, ['dump', 'in-flight', 'event']);
    assert.equal(result.notice?.kind, 'illegal-instruction');
    assert.equal(result.notice?.at, STARTED + 9000);
  });

  await test('Linux 与 macOS 转储也能归类（SIGILL、EXC_BAD_INSTRUCTION）', () => {
    const linux = run({
      dumps: [{ file: '/d/l.dmp', size: 1, mtimeMs: STARTED + 1 }],
      summarize: () => summaryOf(4, 'linux'),
    }).result;
    assert.equal(linux.notice?.kind, 'illegal-instruction');
    const mac = run({
      dumps: [{ file: '/d/m.dmp', size: 1, mtimeMs: STARTED + 1 }],
      summarize: () => summaryOf(2, 'macos'),
    }).result;
    assert.equal(mac.notice?.kind, 'illegal-instruction');
  });

  await test('提示与事件里不含任何路径（只有文件名与引擎名）', () => {
    const { result } = run({
      previous: previous({
        inFlight: [{ ...MARK, candidatePath: 'C:\\Users\\alice\\addon.node' }],
      }),
      dumps: [
        {
          file: 'C:\\Users\\alice\\crash\\a.dmp',
          size: 1,
          mtimeMs: STARTED + 1,
        },
      ],
      summarize: () => summaryOf(0xc0000005),
    });
    const text = JSON.stringify([result.notice, result.event, result.log]);
    assert.ok(!text.includes('alice'), text);
    assert.ok(!text.includes('Users'), text);
  });

  finish('previous-run');
}

main();
