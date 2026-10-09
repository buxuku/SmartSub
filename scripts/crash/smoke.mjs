#!/usr/bin/env node
/**
 * 崩溃诊断烟测：在真实的 Electron 里验证“崩溃能被看见、崩溃循环能被打断”。
 *
 * 做法：用 esbuild 把 main/helpers/crash 下的模块打成 CJS，交给 smoke-main.cjs（Electron 主进程）
 * 加载，用 boom 样本（scripts/crash/boom，真实的原生库，经 process.dlopen 加载）触发真实的原生崩溃，
 * 再在进程外读取转储、事件文件并断言。
 * 单测覆盖不到的就是这一层：crashReporter 是否真的启动、转储是否落在约定目录、
 * child-process-gone 在各平台上的 reason / exitCode 是否被正确分类、
 * 重启后能否据在途标记加转储把崩溃的后端抑制掉。
 *
 * 用法：node scripts/crash/smoke.mjs [场景 ...]   （缺省运行全部场景）
 * 场景：
 *   utility-crash        utilityProcess 里 process.crash()：child-process-gone 分类、转储、应用日志
 *   main-crash           主进程加载 boom-segv（访问违例）：转储与摘要（没有 boom 时退回 process.crash）
 *   utility-ill          经应用的宿主底座起 utilityProcess 并加载 boom-ill（非法指令）：
 *                        主进程存活、退出被分类为指令集问题、stderr 尾部入事件、Linux 上崩溃后秒退
 *   restart-suppression  三次启动：在途标记加非法指令崩溃 → 重启后检测到异常退出并抑制该后端 → 解除后恢复正常
 * 环境变量：
 *   SMOKE_WORK_DIR=<目录>    指定工作目录（CI 里用它上传失败现场）；缺省是系统临时目录下的随机目录
 *   SMOKE_KEEP=1             保留工作目录
 *   SMOKE_NO_SANDBOX=1       给 Electron 加 --no-sandbox（Linux CI 需要；还需要 DISPLAY，CI 里用 xvfb-run）
 *   SMOKE_ELECTRON=<路径>    直接指定 Electron 可执行文件
 *   SMOKE_BOOM_DIR=<目录>    使用已编好的 boom 样本，不再现场编译
 *   SMOKE_REQUIRE_NATIVE=1   boom 样本编不出来时算失败（CI 用）；缺省只跳过需要它的场景
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
// SMOKE_ELECTRON：直接指定 Electron 可执行文件（本机没装 electron 二进制、或要换版本验证时用）
const electronPath = process.env.SMOKE_ELECTRON || require('electron');

const ALL_SCENARIOS = [
  'utility-crash',
  'main-crash',
  'utility-ill',
  'restart-suppression',
];
/** 没有 boom 样本就没法跑的场景（main-crash 有 process.crash 兜底，不在此列） */
const NEEDS_BOOM = new Set(['utility-ill', 'restart-suppression']);
const wanted = process.argv.slice(2);
const scenarios = wanted.length > 0 ? wanted : ALL_SCENARIOS;
for (const s of scenarios) {
  if (!ALL_SCENARIOS.includes(s)) {
    console.error(`未知场景：${s}（可选：${ALL_SCENARIOS.join('、')}）`);
    process.exit(2);
  }
}

const work = process.env.SMOKE_WORK_DIR
  ? path.resolve(process.env.SMOKE_WORK_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-crash-smoke-'));
fs.mkdirSync(work, { recursive: true });
const bundleDir = path.join(work, 'bundle');
const electronBundle = path.join(bundleDir, 'electron-side.cjs');
const nodeBundle = path.join(bundleDir, 'node-side.cjs');
let boomDir = null;

const failures = [];
let passed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}\n${error.stack || error}`);
  }
}

const IS_X64 = process.arch === 'x64';

/**
 * 打两个 CJS：
 * - electron-side：smoke-main.cjs 在 Electron 里加载，所有有状态的模块（nativeGuard、runLifecycle）只能有一份实例，
 *   所以必须是同一个 bundle，而不是每个模块各打一个；
 * - node-side：本脚本自己用来读转储与事件，不能带 electron（本机可能没装 Electron 二进制，require 会抛错）。
 */
async function bundle() {
  const crash = (file) => `./main/helpers/crash/${file}`;
  const build = (contents, outfile, external) =>
    esbuild.build({
      stdin: {
        contents,
        resolveDir: root,
        loader: 'ts',
        sourcefile: 'smoke-entry.ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external,
      logLevel: 'error',
    });
  await build(
    [
      `export * from '${crash('crashReporting')}';`,
      `export { listDumpFiles } from '${crash('crashDumps')}';`,
      `export { beginNativeCall, lookupSuppression, resetSuppressions, snapshotBreaker } from '${crash('nativeGuard')}';`,
      `export { getPreviousRunAssessment, getPreviousRunNotice, markCleanExit } from '${crash('runLifecycle')}';`,
      `export { partitionCandidates, describeSuppressed } from '${crash('addonSuppression')}';`,
      `export { spawnUtilityHost } from '${crash('utilityHost')}';`,
    ].join('\n'),
    electronBundle,
    ['electron'],
  );
  await build(
    [
      `export { listDumpFiles } from '${crash('crashDumps')}';`,
      `export { summarizeMinidumpFile, classifySummaryException } from '${crash('minidumpSummary')}';`,
    ].join('\n'),
    nodeBundle,
    [],
  );
}

/** 编译 boom 样本。失败返回 null（由调用方决定是跳过还是算失败）。 */
function buildBoom() {
  if (process.env.SMOKE_BOOM_DIR) return process.env.SMOKE_BOOM_DIR;
  const out = path.join(work, 'boom');
  const script = path.join(
    here,
    'boom',
    'build.' + (process.platform === 'win32' ? 'ps1' : 'sh'),
  );
  let result;
  if (process.platform === 'win32') {
    // runner 上两个都有：优先 PowerShell 7，没有再退回系统自带的 5.1
    for (const shell of ['pwsh', 'powershell']) {
      result = spawnSync(
        shell,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Out',
          out,
        ],
        { encoding: 'utf8' },
      );
      if (!result.error) break;
    }
  } else {
    result = spawnSync('bash', [script, out], { encoding: 'utf8' });
  }
  const built = ['boom-ill', 'boom-segv'].every((name) =>
    fs.existsSync(path.join(out, `${name}.node`)),
  );
  if (result.status !== 0 || !built) {
    console.error(
      `boom 样本编译失败（退出码 ${result.status}）：\n${String(result.stdout).slice(-800)}\n${String(result.stderr).slice(-800)}`,
    );
    return null;
  }
  return out;
}

/** 启动 Electron 跑一个场景，返回退出信息与结果文件内容。 */
function runScenario(
  scenario,
  { dirName = scenario, timeoutMs = 90_000 } = {},
) {
  const scenarioDir = path.join(work, dirName);
  fs.mkdirSync(scenarioDir, { recursive: true });
  const args = [path.join(here, 'smoke-main.cjs')];
  if (process.env.SMOKE_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electronPath, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        SMOKE_SCENARIO: scenario,
        SMOKE_WORK: scenarioDir,
        SMOKE_BUNDLE: electronBundle,
        SMOKE_BOOM_DIR: boomDir || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    // 记下是不是被我们的超时杀掉的：被超时杀掉不能算“进程自己崩溃退出”
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const resultFile = path.join(scenarioDir, `result-${scenario}.json`);
      const result = fs.existsSync(resultFile)
        ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
        : null;
      resolve({
        exit: { code, signal, ms: Date.now() - started, timedOut },
        result,
        output,
        dir: scenarioDir,
      });
    });
  });
}

const tools = () => require(nodeBundle);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等转储出现，并等它写完（Crashpad 在进程退出后还会继续写，大小连续两次不变才算完）。 */
async function waitForDumps(dir, timeoutMs, { settle = false } = {}) {
  const { listDumpFiles } = tools();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dumps = listDumpFiles(dir);
    if (dumps.length > 0) {
      if (!settle) return dumps;
      await sleep(400);
      const again = listDumpFiles(dir);
      if (
        again.length === dumps.length &&
        again.every((d, i) => d.size === dumps[i].size && d.size > 0)
      ) {
        return again;
      }
    } else {
      await sleep(100);
    }
  }
  return [];
}

function readEvents(dir) {
  const file = path.join(dir, 'userData', 'logs', 'crash-events.jsonl');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

const expectedOs = { win32: 'windows', darwin: 'macos', linux: 'linux' }[
  process.platform
];

const handlers = {
  async 'utility-crash'() {
    const run = await runScenario('utility-crash');
    const r = run.result;
    await check('场景正常结束并写出结果', () => {
      assert.ok(r, `没有结果文件。输出：\n${run.output.slice(-1500)}`);
      assert.equal(run.exit.code, 0);
    });
    if (!r) return;
    await check(
      'crashReporter 已启动，转储目录是约定的 userData/crash-dumps',
      () => {
        assert.equal(r.reporterStarted, true);
        assert.equal(
          path.normalize(r.crashDumpsPath),
          path.normalize(r.expectedCrashDumpsDir),
        );
        assert.ok(
          path
            .normalize(r.crashDumpsPath)
            .endsWith(path.join('userData', 'crash-dumps')),
        );
      },
    );
    await check(
      'app 层收到 child-process-gone；我们设置的 serviceName 出现在 name 字段',
      () => {
        assert.ok(r.gone.length >= 1, JSON.stringify(r.gone));
        // 实测：details.serviceName 是 Chromium 的 node.mojom.NodeService，我们的名字在 details.name
        const ours = r.gone.find((g) => g.name === 'smoke-crash');
        assert.ok(ours, JSON.stringify(r.gone));
        assert.equal(ours.type, 'Utility');
      },
    );
    await check('crash-events.jsonl 里有一条被分类为崩溃的事件', () => {
      const ev = r.events.find(
        (e) => e.source === 'child-process-gone' && e.name === 'smoke-crash',
      );
      assert.ok(ev, JSON.stringify(r.events));
      assert.equal(ev.classification.isCrash, true, JSON.stringify(ev));
      assert.equal(ev.reason, 'crashed');
      assert.equal(ev.platform, process.platform);
      // 真实退出码已被还原，而不是 Crashpad 未启用时的 0xFFFF7003
      assert.notEqual(ev.classification.kind, 'crashpad-lost-code');
    });
    await check('同一事件也进入了应用日志通道（error 级别）', () => {
      const line = r.logs.find((l) => l.message.includes('smoke-crash'));
      assert.ok(line, JSON.stringify(r.logs));
      assert.equal(line.level, 'error');
    });
    await check('产生了转储，且能被摘要器读出异常与 utility 子进程信息', () => {
      assert.ok(r.dumps.length >= 1, '没有转储');
      const s = tools().summarizeMinidumpFile(r.dumps[0]);
      assert.ok(s, '转储无法解析');
      assert.equal(s.os, expectedOs);
      assert.ok(s.exception, JSON.stringify(s));
      assert.ok(s.moduleCount > 0);
      console.log(
        `    · 转储 ${(s.bytes / 1024).toFixed(0)} KB，异常 ${s.exception.name || s.exception.codeHex}，故障模块 ${s.faultModule?.name ?? '无法解析'}`,
      );
    });
    console.log(
      `    · 实测：exit=${JSON.stringify(r.exit)} gone=${JSON.stringify(r.gone)}\n    · 分类：${JSON.stringify(r.events[0]?.classification)}`,
    );
  },

  async 'main-crash'() {
    const run = await runScenario('main-crash');
    const dir = path.join(run.dir, 'userData', 'crash-dumps');
    await check('主进程崩溃：进程自己非正常退出（不是被超时杀掉的）', () => {
      assert.ok(
        run.exit.code !== 0 || run.exit.signal !== null,
        `退出信息：${JSON.stringify(run.exit)}`,
      );
      assert.equal(
        run.exit.timedOut,
        false,
        `崩溃后一直不退出，被超时杀掉：${JSON.stringify(run.exit)}`,
      );
    });
    const dumps = await waitForDumps(dir, 15_000);
    await check('主进程崩溃留下了转储（在约定目录里）', () => {
      assert.ok(dumps.length >= 1, `目录 ${dir} 里没有 .dmp`);
    });
    if (dumps.length === 0) return;
    await check('转储能解析出异常，归类为访问违例，且不是指令集问题', () => {
      const { summarizeMinidumpFile, classifySummaryException } = tools();
      const s = summarizeMinidumpFile(dumps[0].file);
      assert.ok(s, '转储无法解析');
      assert.ok(s.exception, JSON.stringify(s));
      const c = classifySummaryException(s);
      assert.ok(c && c.isCrash, JSON.stringify(c));
      assert.equal(c.isIsa, false, JSON.stringify(c));
      assert.equal(c.kind, 'access-violation', JSON.stringify(c));
      console.log(
        `    · 触发方式 ${run.result?.via ?? '?'}；退出 ${JSON.stringify(run.exit)}；转储 ${(s.bytes / 1024 / 1024).toFixed(1)} MB，异常 ${s.exception.name || s.exception.codeHex}（${c.kind}）`,
      );
    });
  },

  async 'utility-ill'() {
    const run = await runScenario('utility-ill');
    const r = run.result;
    await check('子进程崩溃后主进程存活，并走完场景', () => {
      assert.ok(r, `没有结果文件。输出：\n${run.output.slice(-1500)}`);
      assert.equal(run.exit.code, 0, run.output.slice(-1500));
      assert.ok(!r.exit.timedOut, '等宿主退出超时');
    });
    if (!r) return;
    const info = r.exit.info;
    await check('宿主把退出分类为崩溃，并认定为指令集问题', () => {
      assert.ok(info, JSON.stringify(r.exit));
      assert.equal(info.killedByUs, false);
      assert.equal(info.classification.abnormal, true, JSON.stringify(info));
      assert.equal(info.classification.isCrash, true, JSON.stringify(info));
      assert.equal(info.classification.isIsa, true, JSON.stringify(info));
      assert.equal(info.classification.kind, 'illegal-instruction');
    });
    await check('stderr 尾部被收集（原生崩溃前最后的线索）', () => {
      assert.ok(
        info.stderrTail.includes(
          'about to load the illegal-instruction module',
        ),
        JSON.stringify(info.stderrTail),
      );
    });
    await check(
      'crash-events 里有宿主的 utility-exit 事件，带 stderr 与分类',
      () => {
        const ev = r.events.find(
          (e) => e.source === 'utility-exit' && e.name === 'smoke-ill',
        );
        assert.ok(ev, JSON.stringify(r.events));
        assert.equal(ev.classification.isIsa, true);
        assert.ok(String(ev.detail).includes('illegal-instruction module'));
      },
    );
    await check('app 层的 child-process-gone 也被分类为指令集崩溃', () => {
      const ev = r.events.find(
        (e) => e.source === 'child-process-gone' && e.name === 'smoke-ill',
      );
      assert.ok(ev, JSON.stringify(r.events));
      assert.equal(ev.classification.isIsa, true, JSON.stringify(ev));
      assert.notEqual(ev.classification.kind, 'crashpad-lost-code');
    });
    await check('转储里的异常是非法指令（与退出码判断互相印证）', () => {
      assert.ok(r.dumps.length >= 1, '没有转储');
      const { summarizeMinidumpFile, classifySummaryException } = tools();
      const s = summarizeMinidumpFile(r.dumps[0]);
      assert.ok(s?.exception, JSON.stringify(s));
      const c = classifySummaryException(s);
      assert.ok(c && c.isIsa, JSON.stringify({ exception: s.exception, c }));
      console.log(`    · 转储异常 ${s.exception.name || s.exception.codeHex}`);
    });
    if (process.platform === 'linux') {
      // 先看加固有没有设上，再看崩溃后多久退出：两件事分开，失败时才知道坏在哪一步
      await check('Linux：崩溃前 worker 的 core 软限制已被宿主设为 1', () => {
        assert.match(
          String(r.exit.coreLimitBeforeCrash),
          /Max core file size 1 /,
          `崩溃前取样：atArmed=${r.exit.coreLimitAtArmed} beforeCrash=${r.exit.coreLimitBeforeCrash}；日志：${JSON.stringify(r.logs)}`,
        );
      });
      await check('Linux：加固（RLIMIT_CORE=1）生效，崩溃后 5 秒内退出', () => {
        assert.ok(
          r.exit.msAfterCrash >= 0 && r.exit.msAfterCrash < 5000,
          `崩溃后 ${r.exit.msAfterCrash} ms 才退出（超时时进程状态 ${r.exit.procStateAtTimeout}）；日志：${JSON.stringify(r.logs)}`,
        );
      });
    }
    console.log(
      `    · 实测：宿主收到退出 code=${info?.code}，崩溃后 ${r.exit.msAfterCrash} ms${r.exit.coreLimitBeforeCrash ? `；崩溃前 ${r.exit.coreLimitBeforeCrash}` : ''}\n    · 分类：${JSON.stringify(info?.classification)}\n    · gone=${JSON.stringify(r.gone)}`,
    );
  },

  async 'restart-suppression'() {
    // 三次启动共用一个 userData
    const first = await runScenario('restart-crash', { dirName: 'restart' });
    const dir = first.dir;
    await check('第一次启动：登记在途标记后，主进程撞上非法指令崩溃', () => {
      assert.ok(
        first.exit.code !== 0 || first.exit.signal !== null,
        JSON.stringify(first.exit),
      );
      assert.equal(
        first.exit.timedOut,
        false,
        `崩溃后一直不退出，被超时杀掉：${JSON.stringify(first.exit)}`,
      );
      const state = first.result?.state;
      assert.ok(state, `没有结果。输出：\n${first.output.slice(-1500)}`);
      assert.equal(state.cleanExit, false);
      assert.equal(state.inFlight.length, 1);
      assert.equal(state.inFlight[0].candidateKey, 'builtin:cpu');
    });
    const dumps = await waitForDumps(
      path.join(dir, 'userData', 'crash-dumps'),
      20_000,
      {
        settle: true,
      },
    );
    await check('留下了转储，且已经写完', () => {
      assert.ok(dumps.length >= 1, '没有转储');
    });
    if (dumps.length === 0) return;
    const stateFile = path.join(dir, 'userData', 'crash-state.json');
    await check(
      '崩溃后状态文件仍在，标记着“没走完退出流程”并留着在途标记',
      () => {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.equal(state.cleanExit, false);
        assert.equal(state.inFlight.length, 1);
      },
    );

    const second = await runScenario('restart-check', { dirName: 'restart' });
    const r = second.result;
    await check('第二次启动：正常走完场景', () => {
      assert.ok(r, `没有结果。输出：\n${second.output.slice(-1500)}`);
      assert.equal(second.exit.code, 0, second.output.slice(-1500));
    });
    if (!r) return;
    await check('检测到上次异常退出，证据是新转储加在途标记', () => {
      assert.equal(r.assessment.status, 'abnormal');
      assert.ok(
        r.assessment.evidence.includes('dump'),
        JSON.stringify(r.assessment.evidence),
      );
      assert.ok(r.assessment.evidence.includes('in-flight'));
      assert.equal(r.assessment.inFlight[0].candidateKey, 'builtin:cpu');
      const dump = r.assessment.newDumps[0];
      assert.ok(dump, '没有读到新转储');
      assert.equal(
        dump.classification?.isIsa,
        true,
        JSON.stringify(dump.classification),
      );
    });
    await check(
      '该后端被抑制：强证据、非法指令；x64 抑制整个预编译族，其他架构只抑制该候选',
      () => {
        const s = r.suppression;
        assert.ok(s, '没有抑制记录');
        assert.equal(s.reason, 'isa');
        assert.equal(s.evidence, 'strong');
        assert.equal(
          s.scope,
          IS_X64 ? 'family' : 'candidate',
          JSON.stringify(s),
        );
      },
    );
    await check('加载器的候选过滤：被抑制的候选不再尝试，并给出原因', () => {
      assert.equal(r.usable, 0);
      assert.equal(r.skipped, 1);
      assert.match(r.skippedReason, /Suppressed after a previous run/);
    });
    await check('启动提示里带着“已自动停用”的后端', () => {
      assert.ok(r.notice, '没有启动提示');
      assert.ok(r.notice.suppressed?.length >= 1, JSON.stringify(r.notice));
    });
    await check('crash-events 里记了一条 previous-run 事件', () => {
      assert.ok(
        r.events.some((e) => e.source === 'previous-run'),
        JSON.stringify(r.events),
      );
    });
    await check('抑制表写进了状态文件，诊断快照里也能看到', () => {
      assert.ok(r.stateAfterStart.breaker.suppressions.length >= 1);
      assert.ok(r.snapshot.suppressions.length >= 1);
    });
    await check('手动重置：清掉抑制，之后该候选可用', () => {
      assert.ok(r.cleared >= 1);
      assert.equal(r.afterReset, null);
    });
    await check(
      '第二次启动正常退出后，状态文件记为干净退出且抑制表已空',
      () => {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.equal(state.cleanExit, true);
        assert.equal(state.breaker.suppressions.length, 0);
      },
    );

    const third = await runScenario('restart-clean', { dirName: 'restart' });
    const c = third.result;
    await check('第三次启动：上次是正常退出，没有提示也没有抑制', () => {
      assert.ok(c, `没有结果。输出：\n${third.output.slice(-1500)}`);
      assert.equal(c.assessment.status, 'clean');
      assert.equal(c.notice, null);
      assert.equal(c.suppression, null);
    });
    console.log(
      `    · 抑制：${JSON.stringify(r.suppression)}\n    · 提示：${JSON.stringify(r.notice)}\n    · 候选过滤：${r.skippedReason}\n    · 新转储分类：${JSON.stringify(r.assessment.newDumps[0]?.classification)}`,
    );
  },
};

console.log(
  `崩溃诊断烟测 · ${process.platform}/${process.arch} · 工作目录 ${work}`,
);
await bundle();

if (scenarios.some((s) => s === 'main-crash' || NEEDS_BOOM.has(s))) {
  boomDir = buildBoom();
  if (!boomDir && process.env.SMOKE_REQUIRE_NATIVE === '1') {
    failures.push('boom 样本编译失败（SMOKE_REQUIRE_NATIVE=1）');
  }
}

for (const scenario of scenarios) {
  console.log(`\n=== 场景：${scenario} ===`);
  if (NEEDS_BOOM.has(scenario) && !boomDir) {
    console.log(
      '  - 跳过：没有 boom 样本（需要 C 编译器；CI 里设 SMOKE_REQUIRE_NATIVE=1 会把它当失败）',
    );
    continue;
  }
  try {
    await handlers[scenario]();
  } catch (error) {
    failures.push(`${scenario} 抛出异常`);
    console.error(error.stack || error);
  }
}

if (process.env.SMOKE_KEEP !== '1') {
  try {
    // Windows 上 Crashpad 的 handler 进程可能还占着刚写完的转储，多试几次；清不掉不影响结果
    fs.rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  } catch (error) {
    console.warn(`工作目录没能清理（${work}）：${error.message}`);
  }
} else console.log(`\n已保留工作目录：${work}`);

if (failures.length > 0) {
  console.error(
    `\n烟测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`,
  );
  process.exit(1);
}
console.log(`\n烟测通过：${passed} 项`);
