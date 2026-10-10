'use strict';
/**
 * 崩溃诊断烟测的 Electron 侧脚本（由 smoke.mjs 启动，不属于应用代码）。
 *
 * 模块加载顺序与应用一致：先设 userData → startCrashReporting() → app ready 后 initCrashDiagnostics()，
 * 然后按 SMOKE_SCENARIO 触发真实的原生崩溃，把观察到的现象写进 result-<场景>.json，
 * 由 smoke.mjs 在进程退出后读取并断言。
 *
 * 所有被测模块来自 SMOKE_BUNDLE 里的同一个 CJS：nativeGuard、runLifecycle 这类持有进程内状态的模块
 * 只能有一份实例，否则“在途标记”写进的和启动对账读到的会不是同一个。
 *
 * 环境变量：SMOKE_SCENARIO、SMOKE_WORK（工作目录）、SMOKE_BUNDLE（esbuild 产物）、
 * SMOKE_BOOM_DIR（boom 样本库目录，需要真实原生崩溃的场景才用）。
 * 另外会透传产品自己的开关 SMARTSUB_KEEP_SYSTEM_CORE：smoke.mjs 用它关掉主进程的系统 core 加固，
 * 单独检验宿主底座对 worker 的那两层加固。
 */
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const scenario = process.env.SMOKE_SCENARIO;
const work = process.env.SMOKE_WORK;
const bundle = process.env.SMOKE_BUNDLE;
const boomDir = process.env.SMOKE_BOOM_DIR || '';

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

const m = require(bundle);
// 与 bootstrap.ts 一致：userData 之后、任何子进程之前
m.startCrashReporting();

const logs = [];
const gone = [];
app.on('child-process-gone', (_event, details) => gone.push(details));

const boomFile = (name) => path.join(boomDir, `${name}.node`);

/**
 * 在本进程里加载 boom 样本：与加载 whisper addon 一样走 process.dlopen，
 * 崩溃发生在库加载之后的 napi_register_module_v1 里（在 JS 调用栈内）。
 */
function dlopenBoom(name) {
  const file = boomFile(name);
  if (!boomDir || !fs.existsSync(file))
    throw new Error(`缺少 boom 样本：${file}`);
  process.dlopen({ exports: {} }, file);
}

function listDumps() {
  return m.listDumpFiles(m.getCrashDumpsDir()).map((d) => d.file);
}

function readEvents() {
  const file = m.getCrashEventsFile();
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function readState() {
  const file = m.getRunStateFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Linux：读 /proc/<pid|self>/coredump_filter（十六进制文本）。
 * core_pattern 把 core 管道给 systemd-coredump / apport 的机器上（GitHub runner 就是），
 * 崩溃的进程要等 core 写完才退出；产品在 startCrashReporting 里把主进程的该值写成 0，子进程继承。
 * 烟测不替产品做这件事，只读出来供断言，所以几个崩溃场景能否快速退出就是对产品加固的真实检验。
 */
function readCoreFilter(target) {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync(`/proc/${target}/coredump_filter`, 'utf8').trim();
  } catch (error) {
    return `unreadable: ${error.code || error.message}`;
  }
}

/** Linux：读 /proc/<pid>/limits 里的 core 软限制（宿主侧取样，只用于诊断，不做断言）。 */
function readCoreLimit(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const line = fs
      .readFileSync(`/proc/${pid}/limits`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('Max core file size'));
    return line ? line.replace(/\s+/g, ' ') : null;
  } catch (error) {
    return `unreadable: ${error.code || error.message}`;
  }
}

/** Linux：进程当前状态（S sleeping / D disk sleep / Z zombie ...），崩溃后迟迟不退出时用来看它卡在哪。 */
function readProcState(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const line = fs
      .readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('State:'));
    return line ? line.replace(/\s+/g, ' ') : null;
  } catch (error) {
    return `unreadable: ${error.code || error.message}`;
  }
}

/** 在 utilityProcess 里触发真实的原生崩溃（Electron 的 process.crash 在子进程里可用）。 */
async function crashUtility(serviceName) {
  const workerFile = path.join(work, `crash-worker-${serviceName}.js`);
  fs.writeFileSync(
    workerFile,
    'setTimeout(() => process.crash(), 100);\nsetInterval(() => {}, 1000);\n',
  );
  // 刻意绕开宿主底座、也不替它加固：这个场景看的是 Electron 与应用层对原生崩溃的上报，
  // 以及“只靠主进程自己的 core 加固，被它起的子进程就能快速退出”（子进程继承 coredump_filter）
  const child = utilityProcess.fork(workerFile, [], {
    serviceName,
    stdio: 'pipe',
  });
  let coreFilterAtSpawn = null;
  child.once('spawn', () => {
    if (child.pid !== undefined) coreFilterAtSpawn = readCoreFilter(child.pid);
  });
  const started = Date.now();
  const exit = await new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code, ms: Date.now() - started }));
    setTimeout(() => resolve({ code: null, ms: -1, timedOut: true }), 30000);
  });
  return { ...exit, coreFilterAtSpawn };
}

/**
 * 经应用真正使用的宿主底座起一个 utilityProcess，让它加载 boom-ill 样本，
 * 观察：宿主的退出分类、崩溃事件、转储，以及 Linux 上“崩溃后多久退出”（宿主的 core 加固是否生效）。
 */
async function crashUtilityHost(serviceName) {
  const workerFile = path.join(work, `ill-worker-${serviceName}.js`);
  const selfViewFile = path.join(work, `ill-worker-${serviceName}-self.json`);
  fs.writeFileSync(
    workerFile,
    [
      "const fs = require('fs');",
      `const boom = ${JSON.stringify(boomFile('boom-ill'))};`,
      `const selfViewFile = ${JSON.stringify(selfViewFile)};`,
      "console.error('smoke: the worker is about to load the illegal-instruction module');",
      "process.parentPort.postMessage({ type: 'armed' });",
      'setTimeout(() => {',
      // 崩溃前一刻 worker 自己看到的 core 设置：同步写文件，崩溃后宿主来读。
      // 这才是内核随后会用到的值；宿主侧在 armed 之后取的样会受宿主事件循环延迟影响
      '  try {',
      "    const limit = fs.readFileSync('/proc/self/limits', 'utf8').split('\\n').find((l) => l.startsWith('Max core file size'));",
      "    const filter = fs.readFileSync('/proc/self/coredump_filter', 'utf8').trim();",
      "    fs.writeFileSync(selfViewFile, JSON.stringify({ limit: limit ? limit.replace(/\\s+/g, ' ') : null, filter }));",
      '  } catch (error) {',
      '    fs.writeFileSync(selfViewFile, JSON.stringify({ error: String((error && error.code) || error) }));',
      '  }',
      '  process.dlopen({ exports: {} }, boom);',
      '}, 200);',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  const host = m.spawnUtilityHost({
    workerFile,
    serviceName,
    logLabel: 'smoke worker',
    env: process.env,
    log: (message, level) => logs.push({ level, message }),
    recordExit: m.recordUtilityExit,
    expectKill: m.expectUtilityKill,
  });
  let armedAt = 0;
  // Linux：崩溃前后各取一次 core 软限制与进程状态，加固没生效时能看出是没设上还是设上了仍不退出
  const samples = {};
  host.onMessage((message) => {
    if (message && message.type === 'armed') {
      armedAt = Date.now();
      samples.coreLimitAtArmed = readCoreLimit(host.pid);
      // worker 在 200 ms 后崩溃，崩溃前 50 ms 再取一次
      setTimeout(() => {
        samples.coreLimitBeforeCrash = readCoreLimit(host.pid);
      }, 150);
    }
  });
  const readSelfView = () => {
    try {
      return JSON.parse(fs.readFileSync(selfViewFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const exit = await new Promise((resolve) => {
    host.onExit((info) =>
      resolve({
        info,
        // 从 worker 报告“要崩了”到宿主收到退出，减去它自己等的 200 ms
        msAfterCrash: armedAt ? Date.now() - armedAt - 200 : null,
        ...samples,
      }),
    );
    setTimeout(
      () =>
        resolve({
          info: null,
          msAfterCrash: -1,
          timedOut: true,
          ...samples,
          procStateAtTimeout: readProcState(host.pid),
        }),
      60000,
    );
  });
  exit.workerSelfView = readSelfView();
  return exit;
}

app.whenReady().then(async () => {
  m.initCrashDiagnostics((message, level) => logs.push({ level, message }));

  const base = {
    scenario,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    reporterStarted: m.isCrashReporterStarted(),
    crashDumpsPath: app.getPath('crashDumps'),
    expectedCrashDumpsDir: m.getCrashDumpsDir(),
    // 主进程自己的系统 core 加固（Linux）：产品在 startCrashReporting 里做，这里只取结果
    coreDumpShrink: m.getCoreDumpShrink(),
    coreFilter: readCoreFilter('self'),
  };
  const fakeAddon = path.join(work, 'fake-addon.node');
  const candidateKey = 'builtin:cpu';

  if (scenario === 'main-crash') {
    // 主进程原生崩溃（访问违例）：本进程会死，转储与退出码由 smoke.mjs 在外面检查。
    // 有 boom 样本就走 process.dlopen（贴近 addon 崩溃）；没有就退回 Electron 自带的 process.crash
    const via = boomDir ? 'boom-segv' : 'process.crash';
    writeResult({ ...base, note: 'about-to-crash', via });
    setTimeout(
      () => (boomDir ? dlopenBoom('boom-segv') : process.crash()),
      300,
    );
    return;
  }

  if (scenario === 'utility-crash') {
    const exit = await crashUtility('smoke-crash');
    // child-process-gone 与 exit 的先后不保证，等它出现
    await waitFor(() => gone.length > 0, 5000);
    // 事件已同步落盘；转储由 Crashpad 子进程写，稍等一会儿
    await waitFor(() => listDumps().length > 0, 8000);
    writeResult({
      ...base,
      exit,
      gone,
      events: readEvents(),
      logs,
      dumps: listDumps(),
    });
    app.exit(0);
    return;
  }

  if (scenario === 'utility-ill') {
    const exit = await crashUtilityHost('smoke-ill');
    await waitFor(() => gone.length > 0, 5000);
    await waitFor(() => listDumps().length > 0, 10000);
    writeResult({
      ...base,
      exit,
      gone,
      events: readEvents(),
      logs,
      dumps: listDumps(),
    });
    app.exit(0);
    return;
  }

  if (scenario === 'restart-crash') {
    // 第一次运行：模拟“whisper 转写进行中”（在途标记），然后在主进程里撞上非法指令
    fs.writeFileSync(fakeAddon, 'not a real addon');
    m.beginNativeCall({
      engine: 'whisper-builtin',
      backend: 'cpu',
      candidateKey,
      candidatePath: fakeAddon,
      phase: 'transcribe',
    });
    writeResult({ ...base, note: 'about-to-crash', state: readState() });
    setTimeout(() => dlopenBoom('boom-ill'), 300);
    return;
  }

  if (scenario === 'restart-check') {
    // 第二次运行（同一个 userData）：应当发现上次异常退出、抑制该候选，并能手动解除
    const assessment = m.getPreviousRunAssessment();
    const notice = m.getPreviousRunNotice();
    const suppression = m.lookupSuppression(candidateKey);
    const candidate = {
      backend: 'cpu',
      variant: null,
      source: 'builtin',
      path: fakeAddon,
    };
    const partition = m.partitionCandidates([candidate], (key) =>
      m.lookupSuppression(key),
    );
    const stateAfterStart = readState();
    const snapshot = m.snapshotBreaker();
    const cleared = m.resetSuppressions();
    const afterReset = m.lookupSuppression(candidateKey);
    m.markCleanExit();
    writeResult({
      ...base,
      assessment,
      notice,
      suppression,
      usable: partition.usable.length,
      skipped: partition.skipped.length,
      skippedReason: partition.skipped[0]
        ? m.describeSuppressed(partition.skipped[0].suppression)
        : null,
      stateAfterStart,
      snapshot,
      cleared,
      afterReset,
      events: readEvents(),
      logs,
    });
    app.exit(0);
    return;
  }

  if (scenario === 'restart-clean') {
    // 第三次运行：上一次是正常退出，不应再有提示与抑制
    const assessment = m.getPreviousRunAssessment();
    writeResult({
      ...base,
      assessment,
      notice: m.getPreviousRunNotice(),
      suppression: m.lookupSuppression(candidateKey),
      stateAfterStart: readState(),
    });
    m.markCleanExit();
    app.exit(0);
    return;
  }

  writeResult({ ...base, error: `unknown scenario: ${scenario}` });
  app.exit(3);
});
