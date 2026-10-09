#!/usr/bin/env node
/**
 * 崩溃诊断烟测：在真实的 Electron 里验证“崩溃能被看见”。
 *
 * 做法：用 esbuild 把 main/helpers/crash 下的模块打成 CJS，交给 smoke-main.cjs（Electron 主进程）
 * 加载，触发真实的原生崩溃，再在进程外读取转储、事件文件并断言。
 * 单测覆盖不到的就是这一层：crashReporter 是否真的启动、转储是否落在约定目录、
 * child-process-gone 在各平台上的 reason / exitCode 是否被正确分类。
 *
 * 用法：node scripts/crash/smoke.mjs [场景 ...]   （缺省运行全部场景）
 * 场景：utility-crash、main-crash
 * 环境变量：SMOKE_KEEP=1 保留工作目录；SMOKE_NO_SANDBOX=1 给 Electron 加 --no-sandbox（Linux CI 需要）。
 */
import { spawn } from 'node:child_process';
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
const electronPath = require('electron');

const ALL_SCENARIOS = ['utility-crash', 'main-crash'];
const wanted = process.argv.slice(2);
const scenarios = wanted.length > 0 ? wanted : ALL_SCENARIOS;
for (const s of scenarios) {
  if (!ALL_SCENARIOS.includes(s)) {
    console.error(`未知场景：${s}（可选：${ALL_SCENARIOS.join('、')}）`);
    process.exit(2);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-crash-smoke-'));
const bundleDir = path.join(work, 'bundle');

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

async function bundle() {
  const crash = (file) => path.join(root, 'main/helpers/crash', file);
  await esbuild.build({
    entryPoints: {
      crashReporting: crash('crashReporting.ts'),
      minidumpSummary: crash('minidumpSummary.ts'),
      crashEvents: crash('crashEvents.ts'),
      crashDumps: crash('crashDumps.ts'),
      exitClassifier: crash('exitClassifier.ts'),
    },
    outdir: bundleDir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'error',
  });
}

/** 启动 Electron 跑一个场景，返回退出信息与结果文件内容。 */
function runScenario(scenario, timeoutMs = 90_000) {
  const scenarioDir = path.join(work, scenario);
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
        SMOKE_BUNDLE: bundleDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const resultFile = path.join(scenarioDir, `result-${scenario}.json`);
      const result = fs.existsSync(resultFile)
        ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
        : null;
      resolve({
        exit: { code, signal, ms: Date.now() - started },
        result,
        output,
        dir: scenarioDir,
      });
    });
  });
}

const summary = () => require(path.join(bundleDir, 'minidumpSummary.cjs'));

async function waitForDumps(dir, timeoutMs) {
  const { listDumpFiles } = require(path.join(bundleDir, 'crashDumps.cjs'));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dumps = listDumpFiles(dir);
    if (dumps.length > 0) return dumps;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

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
      const s = summary().summarizeMinidumpFile(r.dumps[0]);
      assert.ok(s, '转储无法解析');
      assert.equal(
        s.os,
        { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform],
      );
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
    await check('主进程崩溃：进程非正常退出', () => {
      assert.ok(
        run.exit.code !== 0 || run.exit.signal !== null,
        `退出信息：${JSON.stringify(run.exit)}`,
      );
    });
    const dumps = await waitForDumps(dir, 10_000);
    await check('主进程崩溃留下了转储（在约定目录里）', () => {
      assert.ok(dumps.length >= 1, `目录 ${dir} 里没有 .dmp`);
    });
    if (dumps.length === 0) return;
    await check('转储能解析出异常，并能归类为崩溃', () => {
      const { summarizeMinidumpFile, classifySummaryException } = summary();
      const s = summarizeMinidumpFile(dumps[0].file);
      assert.ok(s, '转储无法解析');
      assert.ok(s.exception, JSON.stringify(s));
      const c = classifySummaryException(s);
      assert.ok(c && c.isCrash, JSON.stringify(c));
      console.log(
        `    · 退出 ${JSON.stringify(run.exit)}；转储 ${(s.bytes / 1024 / 1024).toFixed(1)} MB，异常 ${s.exception.name || s.exception.codeHex}（${c.kind}）`,
      );
    });
  },
};

console.log(
  `崩溃诊断烟测 · ${process.platform}/${process.arch} · 工作目录 ${work}`,
);
await bundle();
for (const scenario of scenarios) {
  console.log(`\n=== 场景：${scenario} ===`);
  try {
    await handlers[scenario]();
  } catch (error) {
    failures.push(`${scenario} 抛出异常`);
    console.error(error.stack || error);
  }
}

if (process.env.SMOKE_KEEP !== '1')
  fs.rmSync(work, { recursive: true, force: true });
else console.log(`\n已保留工作目录：${work}`);

if (failures.length > 0) {
  console.error(
    `\n烟测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`,
  );
  process.exit(1);
}
console.log(`\n烟测通过：${passed} 项`);
