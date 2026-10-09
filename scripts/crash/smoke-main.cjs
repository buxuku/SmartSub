'use strict';
/**
 * 崩溃诊断烟测的 Electron 侧脚本（由 smoke.mjs 启动，不属于应用代码）。
 *
 * 模块加载顺序与应用一致：先设 userData → startCrashReporting() → app ready 后 initCrashDiagnostics()，
 * 然后按 SMOKE_SCENARIO 触发真实的原生崩溃，把观察到的现象写进 result-<场景>.json，
 * 由 smoke.mjs 在进程退出后读取并断言。
 *
 * 环境变量：SMOKE_SCENARIO、SMOKE_WORK（工作目录）、SMOKE_BUNDLE（esbuild 产物目录）。
 */
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const scenario = process.env.SMOKE_SCENARIO;
const work = process.env.SMOKE_WORK;
const bundle = process.env.SMOKE_BUNDLE;

if (!scenario || !work || !bundle) {
  console.error('缺少 SMOKE_SCENARIO / SMOKE_WORK / SMOKE_BUNDLE');
  process.exit(2);
}

const resultFile = path.join(work, `result-${scenario}.json`);
const writeResult = (data) =>
  fs.writeFileSync(resultFile, JSON.stringify(data, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath('userData', path.join(work, 'userData'));
app.dock?.hide();

const reporting = require(path.join(bundle, 'crashReporting.cjs'));
// 与 bootstrap.ts 一致：userData 之后、任何子进程之前
reporting.startCrashReporting();

const logs = [];
const gone = [];
app.on('child-process-gone', (_event, details) => gone.push(details));

function listDumps() {
  const dir = reporting.getCrashDumpsDir();
  const found = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true })
      : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.dmp')) found.push(p);
    }
  };
  walk(dir);
  return found;
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

/** 在 utilityProcess 里触发真实的原生崩溃（Electron 的 process.crash 在子进程里可用）。 */
async function crashUtility(serviceName) {
  const workerFile = path.join(work, `crash-worker-${serviceName}.js`);
  fs.writeFileSync(
    workerFile,
    'setTimeout(() => process.crash(), 100);\nsetInterval(() => {}, 1000);\n',
  );
  const child = utilityProcess.fork(workerFile, [], {
    serviceName,
    stdio: 'pipe',
  });
  const started = Date.now();
  const exit = await new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code, ms: Date.now() - started }));
    setTimeout(() => resolve({ code: null, ms: -1, timedOut: true }), 30000);
  });
  return exit;
}

app.whenReady().then(async () => {
  reporting.initCrashDiagnostics((message, level) =>
    logs.push({ level, message }),
  );

  const base = {
    scenario,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    reporterStarted: reporting.isCrashReporterStarted(),
    crashDumpsPath: app.getPath('crashDumps'),
    expectedCrashDumpsDir: reporting.getCrashDumpsDir(),
  };

  if (scenario === 'main-crash') {
    // 主进程原生崩溃：本进程会死，转储与退出码由 smoke.mjs 在外面检查
    writeResult({ ...base, note: 'about-to-crash' });
    setTimeout(() => process.crash(), 300);
    return;
  }

  if (scenario === 'utility-crash') {
    const exit = await crashUtility('smoke-crash');
    // child-process-gone 与 exit 的先后不保证，等它出现
    await waitFor(() => gone.length > 0, 5000);
    // 事件已同步落盘；转储由 Crashpad 子进程写，稍等一会儿
    await waitFor(() => listDumps().length > 0, 8000);
    const eventsFile = reporting.getCrashEventsFile();
    const events = fs.existsSync(eventsFile)
      ? fs
          .readFileSync(eventsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    writeResult({
      ...base,
      exit,
      gone,
      events,
      logs,
      dumps: listDumps(),
    });
    app.exit(0);
    return;
  }

  writeResult({ ...base, error: `unknown scenario: ${scenario}` });
  app.exit(3);
});
