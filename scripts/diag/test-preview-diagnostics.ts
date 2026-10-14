/**
 * 预览黑屏诊断层的纯逻辑测试（不依赖 electron）。
 *
 * 最重要的一条：默认开关 = 3.9.0 的行为。诊断版里所有开关默认都不改变任何东西，
 * 这条测试守住它，防止以后有人调整默认值而不自知。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GPU_PRESETS,
  findGpuPreset,
  isDiagnosticBuild,
  isPreviewDiagnosticsEnabled,
  mergeCommaList,
  parseGpuPresetFile,
  planSwitches,
} from '../../main/helpers/previewDiagnostics/config';
import { interpretProbe } from '../../main/helpers/previewDiagnostics/diagnosis';
import { lumaStats } from '../../main/helpers/previewDiagnostics/luminance';
import {
  NdjsonLog,
  MAX_ENTRY_CHARS,
  serializeEntry,
} from '../../main/helpers/previewDiagnostics/logWriter';
import { parseRegQuery } from '../../main/helpers/previewDiagnostics/regQuery';
import {
  findOwnWindowSource,
  pickScreenSource,
  screenCaptureGeometry,
  windowHandleOf,
} from '../../main/helpers/previewDiagnostics/sourceMatch';
import {
  installDiagInterposer,
  type DiagScope,
} from '../../renderer/lib/jassub/diagInterposer';
import {
  DEFAULT_FLAGS,
  MITIGATE_ALL_FLAGS,
  changedFlags,
  jassubDiagKey,
  jassubDiagOption,
  normalizeFlags,
} from '../../renderer/lib/previewDiagnostics';

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>) =>
  tests.push([name, run]);

// ───────────── 判定：只有诊断安装包 / 显式环境变量才启用 ─────────────

test('正式版（可执行文件名不含 Diagnostic、无环境变量）不启用诊断', () => {
  assert.equal(
    isDiagnosticBuild('C:\\Program Files\\SmartSub\\SmartSub.exe'),
    false,
  );
  assert.equal(
    isPreviewDiagnosticsEnabled(
      {},
      '/Applications/SmartSub.app/Contents/MacOS/SmartSub',
    ),
    false,
  );
  assert.equal(
    isPreviewDiagnosticsEnabled({ SMARTSUB_PREVIEW_DIAG: '0' }, 'SmartSub.exe'),
    false,
  );
});

test('诊断安装包按可执行文件名识别，也可用环境变量显式启用', () => {
  assert.equal(
    isDiagnosticBuild(
      'C:\\Program Files\\SmartSub Diagnostic\\SmartSub Diagnostic.exe',
    ),
    true,
  );
  assert.equal(
    isPreviewDiagnosticsEnabled({}, 'C:\\x\\SmartSub Diagnostic.exe'),
    true,
  );
  assert.equal(
    isPreviewDiagnosticsEnabled({ SMARTSUB_PREVIEW_DIAG: '1' }, 'SmartSub.exe'),
    true,
  );
});

// ───────────── 默认开关：不改变任何行为 ─────────────

test('默认开关不改变任何行为（守护测试）', () => {
  assert.deepEqual(
    { ...DEFAULT_FLAGS },
    {
      disableJassub: false,
      jassubHideCanvas: false,
      boundsReadback: true,
      jassubDesync: 'unchanged',
      jassubPower: 'unchanged',
      jassubRenderer: 'auto',
      subtitleLayer: true,
      handleMode: 'hover',
      ancestorFilter: false,
      roundedClip: false,
      noHoverScrollbar: false,
      marker: false,
    },
  );
  assert.deepEqual(changedFlags(normalizeFlags(undefined)), {});
  assert.equal(jassubDiagOption(DEFAULT_FLAGS as never), undefined);
  assert.equal(jassubDiagKey(DEFAULT_FLAGS as never), '');
});

test('normalizeFlags 丢弃未知键、拒绝非法取值', () => {
  const flags = normalizeFlags({
    disableJassub: true,
    handleMode: 'nope',
    jassubDesync: 'false',
    bogus: 1,
    boundsReadback: 'yes',
  });
  assert.equal(flags.disableJassub, true);
  assert.equal(flags.handleMode, 'hover');
  assert.equal(flags.jassubDesync, 'false');
  assert.equal(flags.boundsReadback, true);
  assert.equal('bogus' in flags, false);
});

test('jassubDiagOption 只带上被改动的 JASSUB 参数', () => {
  const flags = normalizeFlags({
    jassubDesync: 'false',
    jassubRenderer: 'webgl1',
  });
  assert.deepEqual(jassubDiagOption(flags), {
    desynchronized: false,
    renderer: 'webgl1',
  });
  assert.notEqual(
    jassubDiagKey(flags),
    jassubDiagKey(normalizeFlags({ jassubDesync: 'false' })),
  );
  assert.deepEqual(
    jassubDiagOption(normalizeFlags({ jassubPower: 'low-power' })),
    {
      powerPreference: 'low-power',
    },
  );
});

test('jassubDesync 可强制为 true（复现 3.9.0 黑屏）或 false；「不改」不下发任何选项', () => {
  const forceTrue = normalizeFlags({ jassubDesync: 'true' });
  const forceFalse = normalizeFlags({ jassubDesync: 'false' });
  assert.equal(forceTrue.jassubDesync, 'true');
  assert.deepEqual(jassubDiagOption(forceTrue), { desynchronized: true });
  assert.deepEqual(jassubDiagOption(forceFalse), { desynchronized: false });
  assert.equal(
    jassubDiagOption(normalizeFlags({ jassubDesync: 'unchanged' })),
    undefined,
  );
  assert.notEqual(jassubDiagKey(forceTrue), jassubDiagKey(forceFalse));
  assert.deepEqual(changedFlags(forceTrue), { jassubDesync: 'true' });
});

test('「全部缓解」是合法开关，且确实改变了东西', () => {
  const flags = normalizeFlags({ ...MITIGATE_ALL_FLAGS });
  assert.equal(flags.boundsReadback, false);
  assert.equal(flags.jassubDesync, 'false');
  assert.equal(flags.ancestorFilter, true);
  assert.equal(flags.disableJassub, false, '全部缓解不应关掉字幕本身');
  assert.ok(Object.keys(changedFlags(flags)).length >= 5);
});

// ───────────── GPU 预设 ─────────────

test('GPU 预设：id 唯一，默认预设不带任何开关', () => {
  const ids = GPU_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(findGpuPreset('default').switches, []);
  assert.equal(findGpuPreset('不存在的预设').id, 'default');
  assert.equal(findGpuPreset(undefined).id, 'default');
});

test('预设文件损坏或字段不对一律回退默认', () => {
  assert.equal(parseGpuPresetFile(null), 'default');
  assert.equal(parseGpuPresetFile(''), 'default');
  assert.equal(parseGpuPresetFile('{not json'), 'default');
  assert.equal(parseGpuPresetFile('{"presetId":123}'), 'default');
  assert.equal(parseGpuPresetFile('{"presetId":"angle-gl"}'), 'angle-gl');
});

test('mergeCommaList 去重、保序、忽略空项', () => {
  assert.equal(mergeCommaList('', ['A']), 'A');
  assert.equal(mergeCommaList('A,B', ['B', 'C']), 'A,B,C');
  assert.equal(mergeCommaList(' A , ,B', []), 'A,B');
});

test('planSwitches 与命令行上已有的 disable-features 合并而不是覆盖', () => {
  const preset = findGpuPreset('no-sw-overlays');
  const plan = planSwitches(preset, {
    getSwitchValue: (name) => (name === 'disable-features' ? 'Foo' : ''),
  });
  assert.deepEqual(plan, [
    ['disable-features', 'Foo,DirectCompositionSoftwareOverlays'],
  ]);
  assert.deepEqual(
    planSwitches(findGpuPreset('no-gpu-compositing'), {
      getSwitchValue: () => '',
    }),
    [['disable-gpu-compositing', undefined]],
  );
  assert.deepEqual(
    planSwitches(findGpuPreset('default'), { getSwitchValue: () => '' }),
    [],
  );
});

// ───────────── 亮度统计与判断 ─────────────

const solid = (
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([b, g, r, 255], i * 4); // BGRA
  }
  return data;
};

test('lumaStats：纯黑与纯白', () => {
  const black = lumaStats(solid(32, 18, 0, 0, 0), 32, 18);
  assert.ok(black);
  assert.equal(black.mean, 0);
  assert.equal(black.darkRatio, 1);
  const white = lumaStats(solid(32, 18, 255, 255, 255), 32, 18);
  assert.ok(white);
  assert.ok(white.mean > 250);
  assert.equal(white.darkRatio, 0);
});

test('lumaStats：区域被裁剪到位图范围内，空区域与长度不符返回 null', () => {
  const data = solid(10, 10, 255, 255, 255);
  const clipped = lumaStats(
    data,
    10,
    10,
    { x: -5, y: -5, width: 100, height: 100 },
    'bgra',
    1,
  );
  assert.ok(clipped);
  assert.deepEqual(clipped.region, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(
    lumaStats(data, 10, 10, { x: 50, y: 50, width: 5, height: 5 }),
    null,
  );
  assert.equal(lumaStats(new Uint8Array(8), 10, 10), null);
});

test('lumaStats：只取区域内的像素，且通道顺序生效', () => {
  const data = solid(10, 10, 0, 0, 0);
  for (let y = 0; y < 10; y++)
    for (let x = 5; x < 10; x++) data.set([0, 0, 255, 255], (y * 10 + x) * 4); // BGRA 红
  const left = lumaStats(
    data,
    10,
    10,
    { x: 0, y: 0, width: 5, height: 10 },
    'bgra',
    1,
  );
  const right = lumaStats(
    data,
    10,
    10,
    { x: 5, y: 0, width: 5, height: 10 },
    'bgra',
    1,
  );
  assert.equal(left?.darkRatio, 1);
  assert.equal(right?.darkRatio, 0);
  const asRgba = lumaStats(
    data,
    10,
    10,
    { x: 5, y: 0, width: 5, height: 10 },
    'rgba',
    1,
  );
  assert.ok(asRgba && asRgba.mean < right!.mean, '把红色当蓝色算，亮度应更低');
});

test('interpretProbe：呈现层黑 / 合成器黑 / 不黑 / 视频本身是黑场', () => {
  const dark = { darkRatio: 1 };
  const lit = { darkRatio: 0.1 };
  assert.equal(
    interpretProbe({ baseline: lit, viz: lit, os: dark }).verdict,
    'present-layer-black',
  );
  assert.equal(
    interpretProbe({ baseline: lit, viz: dark, os: dark }).verdict,
    'compositor-black',
  );
  assert.equal(
    interpretProbe({ baseline: lit, viz: lit, os: lit }).verdict,
    'not-black',
  );
  assert.equal(
    interpretProbe({ baseline: dark, viz: dark, os: dark }).verdict,
    'inconclusive',
  );
  assert.equal(
    interpretProbe({ baseline: lit, viz: lit, os: { darkRatio: 0.8 } }).verdict,
    'inconclusive',
  );
});

test('interpretProbe：没有系统层读数时只凭合成器层判断，并提示缺少基线', () => {
  const result = interpretProbe({
    baseline: null,
    viz: { darkRatio: 1 },
    os: null,
  });
  assert.equal(result.verdict, 'compositor-black');
  assert.match(result.text, /基线/);
  assert.equal(
    interpretProbe({ baseline: null, viz: { darkRatio: 0 }, os: null }).verdict,
    'inconclusive',
  );
});

// ───────────── 日志写入 ─────────────

test('serializeEntry：循环引用、BigInt、超长内容都不抛错', () => {
  const circular: Record<string, unknown> = { type: 'x' };
  circular.self = circular;
  assert.equal(JSON.parse(serializeEntry(circular)).type, 'unserializable');
  assert.equal(JSON.parse(serializeEntry({ n: 10n })).n, '10');
  const huge = JSON.parse(
    serializeEntry({ type: 'big', text: 'x'.repeat(MAX_ENTRY_CHARS * 2) }),
  );
  assert.equal(huge.type, 'truncated');
  assert.equal(huge.originalType, 'big');
});

test('NdjsonLog：追加、每行一个 JSON、超过上限轮转为 .1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-log-'));
  const file = path.join(dir, 'events.ndjson');
  const log = new NdjsonLog(file, 400);
  await log.append([
    { type: 'a', n: 1 },
    { type: 'b', n: 2 },
  ]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).type),
    ['a', 'b'],
  );
  for (let i = 0; i < 20; i++)
    await log.append([{ type: 'fill', i, pad: 'x'.repeat(40) }]);
  await log.flush();
  assert.ok(fs.existsSync(`${file}.1`), '应已轮转');
  assert.ok(fs.statSync(file).size <= 400 + 200);
  assert.ok(
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .every((line) => JSON.parse(line)),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────── reg query 解析 ─────────────

test('parseRegQuery 解析键、值名（含空格）、类型与数据', () => {
  const text = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\Dwm',
    '    OverlayTestMode    REG_DWORD    0x5',
    '    Some Name With Space    REG_SZ    hello world',
    '    Empty    REG_SZ',
    '',
  ].join('\r\n');
  const [dump] = parseRegQuery(text);
  assert.equal(
    dump.key,
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\Dwm',
  );
  assert.deepEqual(dump.values.OverlayTestMode, {
    type: 'REG_DWORD',
    data: '0x5',
  });
  assert.deepEqual(dump.values['Some Name With Space'], {
    type: 'REG_SZ',
    data: 'hello world',
  });
  assert.deepEqual(dump.values.Empty, { type: 'REG_SZ', data: '' });
  assert.deepEqual(parseRegQuery(''), []);
});

// ───────────── 系统层截图：认出自己的窗口 ─────────────

test('windowHandleOf 只取窗口句柄这一段', () => {
  assert.equal(windowHandleOf('window:1324:0'), '1324');
  assert.equal(windowHandleOf('window:197190:42'), '197190');
  assert.equal(windowHandleOf('screen:1:0'), null);
  assert.equal(windowHandleOf('window:abc:0'), null);
  assert.equal(windowHandleOf(''), null);
});

test('findOwnWindowSource：只认窗口句柄，尾段（1=本进程 / 0=其它进程）不参与比较', () => {
  const sources = [{ id: 'window:1324:0', name: 'SmartSub' }];
  assert.equal(
    findOwnWindowSource(sources, { mediaSourceId: 'window:1324:1' }),
    sources[0],
  );
  // 整串比较在尾段不一致时找不到
  assert.equal(
    sources.find((source) => source.id === 'window:1324:1'),
    undefined,
  );
});

test('findOwnWindowSource：别的进程的窗口不会被当成自己（CI 上列出的就是别人的窗口）', () => {
  // Windows CI 的真实数据：own window:524694:1，列出的只有 [window:131584:0]
  const sources = [{ id: 'window:131584:0', name: 'Console' }];
  assert.equal(
    findOwnWindowSource(sources, {
      mediaSourceId: 'window:524694:1',
      nativeHandle: '524694',
      title: 'SmartSub',
    }),
    null,
  );
});

test('findOwnWindowSource：按 getNativeWindowHandle 的句柄兜底', () => {
  const sources = [
    { id: 'window:11:0', name: 'Other' },
    { id: 'window:2222:0', name: 'Whatever' },
  ];
  assert.equal(
    findOwnWindowSource(sources, {
      mediaSourceId: 'window:0:0',
      nativeHandle: '2222',
    }),
    sources[1],
  );
});

test('findOwnWindowSource：句柄对不上时只在标题唯一时才按标题认', () => {
  const unique = [
    { id: 'window:1:0', name: 'Notepad' },
    { id: 'window:2:0', name: 'SmartSub' },
  ];
  assert.equal(
    findOwnWindowSource(unique, {
      mediaSourceId: 'window:9:0',
      title: 'SmartSub',
    }),
    unique[1],
  );
  const twins = [
    { id: 'window:1:0', name: 'SmartSub' },
    { id: 'window:2:0', name: 'SmartSub' },
  ];
  assert.equal(
    findOwnWindowSource(twins, {
      mediaSourceId: 'window:9:0',
      title: 'SmartSub',
    }),
    null,
    '同名窗口有两个时宁可没找到，也不把别人当成自己',
  );
  assert.equal(
    findOwnWindowSource(unique, { mediaSourceId: 'window:9:0' }),
    null,
  );
  assert.equal(
    findOwnWindowSource([], { mediaSourceId: 'window:9:0', title: 'x' }),
    null,
  );
});

test('pickScreenSource：按 display_id 找；取不到时只有一块屏幕才用，多块屏幕不猜', () => {
  const two = [
    { id: 'screen:0:0', display_id: '2528732444' },
    { id: 'screen:1:0', display_id: '2779098405' },
  ];
  assert.equal(pickScreenSource(two, 2779098405), two[1]);
  assert.equal(pickScreenSource(two, '2528732444'), two[0]);
  assert.equal(pickScreenSource(two, 42), null, '多块屏幕又对不上时宁可没有');

  const lonely = [{ id: 'screen:0:0', display_id: '' }];
  assert.equal(pickScreenSource(lonely, 42), lonely[0]);
  assert.equal(pickScreenSource([], 42), null);
  assert.equal(
    pickScreenSource([{ id: 'window:1:0', display_id: '' }], 42),
    null,
    '窗口源不算屏幕',
  );
});

test('screenCaptureGeometry：1 倍缩放下，窗口与视频区域换算到整屏缩略图', () => {
  const geometry = screenCaptureGeometry({
    windowBounds: { x: 100, y: 50, width: 1280, height: 900 },
    contentBounds: { x: 108, y: 81, width: 1264, height: 861 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    videoRect: { x: 300, y: 120, width: 640, height: 360 },
  });
  assert.deepEqual(geometry?.crop, { x: 100, y: 50, width: 1280, height: 900 });
  // 内容区相对窗口外框偏移 (8, 31)，再加页面内偏移
  assert.deepEqual(geometry?.video, {
    x: 308,
    y: 151,
    width: 640,
    height: 360,
  });
});

test('screenCaptureGeometry：高分屏（DIP 与像素 1.25 倍）与副屏偏移', () => {
  const geometry = screenCaptureGeometry({
    // 副屏：DIP 原点在 (1536, 0)；缩略图 1920x1080 对应 1536x864 DIP
    windowBounds: { x: 1616, y: 40, width: 1000, height: 700 },
    contentBounds: { x: 1616, y: 40, width: 1000, height: 700 },
    displayBounds: { x: 1536, y: 0, width: 1536, height: 864 },
    imageSize: { width: 1920, height: 1080 },
    videoRect: { x: 80, y: 40, width: 400, height: 200 },
  });
  assert.deepEqual(geometry?.crop, { x: 100, y: 50, width: 1250, height: 875 });
  assert.deepEqual(geometry?.video, { x: 100, y: 50, width: 500, height: 250 });
});

test('screenCaptureGeometry：窗口部分在屏幕外时裁到图内，视频区域坐标随之平移', () => {
  const geometry = screenCaptureGeometry({
    windowBounds: { x: -100, y: -50, width: 1280, height: 900 },
    contentBounds: { x: -100, y: -50, width: 1280, height: 900 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    videoRect: { x: 300, y: 120, width: 640, height: 360 },
  });
  assert.deepEqual(geometry?.crop, { x: 0, y: 0, width: 1180, height: 850 });
  // 视频区域在屏幕坐标是 (200, 70)；裁剪起点就是屏幕原点，所以不再多减
  assert.deepEqual(geometry?.video, { x: 200, y: 70, width: 640, height: 360 });
});

test('screenCaptureGeometry：窗口完全在屏幕外 / 输入退化时返回 null', () => {
  const base = {
    contentBounds: { x: 0, y: 0, width: 100, height: 100 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    imageSize: { width: 1920, height: 1080 },
    videoRect: { x: 0, y: 0, width: 10, height: 10 },
  };
  assert.equal(
    screenCaptureGeometry({
      ...base,
      windowBounds: { x: 2000, y: 0, width: 500, height: 500 },
    }),
    null,
  );
  assert.equal(
    screenCaptureGeometry({
      ...base,
      windowBounds: { x: 0, y: 0, width: 500, height: 500 },
      imageSize: { width: 0, height: 0 },
    }),
    null,
  );
});

// ───────────── JASSUB 诊断补丁 ─────────────

test('patch-jassub：打补丁幂等、可还原、锚点缺失时失败退出', () => {
  const source = path.resolve('node_modules/jassub');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-jassub-'));
  const files = [
    'package.json',
    'dist/jassub.js',
    'dist/worker/worker.js',
    'dist/worker/renderers/webgl2-renderer.js',
    'dist/worker/renderers/webgl1-renderer.js',
    'dist/worker/renderers/2d-renderer.js',
  ];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    fs.copyFileSync(path.join(source, rel), path.join(copy, rel));
  }
  const original = Object.fromEntries(
    files.map((rel) => [rel, fs.readFileSync(path.join(copy, rel), 'utf8')]),
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/diag/patch-jassub.mjs', ...args], {
      env: { ...process.env, SMARTSUB_JASSUB_DIR: copy },
      encoding: 'utf8',
    });

  assert.equal(run('--check').status, 1, '打补丁前 --check 应失败');
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  const worker = fs.readFileSync(
    path.join(copy, 'dist/worker/worker.js'),
    'utf8',
  );
  assert.match(worker, /__SMARTSUB_JASSUB_DIAG__/);
  assert.match(worker, /smartsub-jassub-diag/);
  assert.match(worker, /requestedAttributes/);
  // getContext 拦截器不再由补丁装在 worker 里：它由 workerGuard 在正式版守卫之前装好
  // （离原生 getContext 更近，强制 true 才不会被守卫改回去）。补丁若又装一个，就会盖在守卫外面。
  assert.doesNotMatch(worker, /OffscreenCanvas\.prototype\.getContext/);
  // 渲染器源码保持原样：诊断开关统一应用在 getContext 处，不改渲染器里的字面量。
  for (const rel of files.filter((file) => file.includes('/renderers/')))
    assert.equal(
      fs.readFileSync(path.join(copy, rel), 'utf8'),
      original[rel],
      `${rel} must stay untouched by the diagnostic patch`,
    );
  assert.match(
    fs.readFileSync(path.join(copy, 'dist/jassub.js'), 'utf8'),
    /diag: opts\.diag \?\? null/,
  );
  // 第二次打补丁不改变内容
  const patched = fs.readFileSync(
    path.join(copy, 'dist/worker/worker.js'),
    'utf8',
  );
  assert.equal(run().status, 0);
  assert.equal(
    fs.readFileSync(path.join(copy, 'dist/worker/worker.js'), 'utf8'),
    patched,
  );
  // 还原后字节一致
  assert.equal(run('--restore').status, 0);
  for (const rel of files)
    assert.equal(
      fs.readFileSync(path.join(copy, rel), 'utf8'),
      original[rel],
      rel,
    );
  // 锚点被破坏时拒绝打补丁，且不留下半成品（先于它处理的文件也不会被改动）
  const broken = path.join(copy, 'dist/worker/worker.js');
  fs.writeFileSync(
    broken,
    original['dist/worker/worker.js'].replace(
      'this.debug = data.debug;',
      'this.debug = !!data.debug;',
    ),
  );
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /expected exactly 1 anchor/);
  assert.equal(
    fs.readFileSync(path.join(copy, 'dist/jassub.js'), 'utf8'),
    original['dist/jassub.js'],
    '失败时其它文件不应被改动',
  );
  fs.rmSync(copy, { recursive: true, force: true });
});

// 诊断拦截器（renderer/lib/jassub/diagInterposer.ts）：既要正确应用诊断开关，
// 也要在开关为默认值时原样透传（默认路径 = 正式版行为，包括 Windows 的守卫）。
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) smartsub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) smartsub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';

type ContextCall = { type: string; attrs: Record<string, unknown> | undefined };
type FakeCanvas = {
  getContext(type: string, attrs?: Record<string, unknown>): unknown;
};

/** 沙箱对象的原型与宿主可能不同，deepEqual 会因此失败：先转成普通对象。 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** 一块只记录「原生 getContext 实际收到什么」的 OffscreenCanvas 替身。 */
function createFakeCanvasClass() {
  const received: ContextCall[] = [];
  class FakeOffscreenCanvas implements FakeCanvas {
    getContext(type: string, attrs?: Record<string, unknown>) {
      received.push({ type, attrs });
      return {};
    }
  }
  return { FakeOffscreenCanvas, received };
}

function installDiagOnFakeScope(diag?: Record<string, unknown>) {
  const { FakeOffscreenCanvas, received } = createFakeCanvasClass();
  const scope: DiagScope & { __SMARTSUB_JASSUB_REQUESTS__?: unknown } = {
    OffscreenCanvas: FakeOffscreenCanvas,
    __SMARTSUB_JASSUB_DIAG__: diag,
  };
  assert.equal(installDiagInterposer(scope), true);
  return {
    scope,
    canvas: new FakeOffscreenCanvas(),
    received,
    requests: () =>
      plain(
        scope.__SMARTSUB_JASSUB_REQUESTS__ as Array<Record<string, unknown>>,
      ),
  };
}

test('诊断拦截器：开关为默认值时原样透传，并记录渲染器真正的请求', () => {
  const { canvas, received, requests } = installDiagOnFakeScope({});
  const attrs = {
    alpha: true,
    desynchronized: false,
    powerPreference: 'high-performance',
  };
  canvas.getContext('webgl2', attrs);
  canvas.getContext('webgl2'); // JASSUB 的探测调用：不带属性
  assert.equal(received.length, 2);
  assert.equal(received[0].attrs, attrs, '默认不应复制或改写属性对象');
  assert.equal(received[1].attrs, undefined);
  assert.deepEqual(requests(), [
    {
      type: 'webgl2',
      desynchronized: false,
      powerPreference: 'high-performance',
    },
  ]);
});

test('诊断拦截器：强制开关覆盖渲染器的请求，且不改动原对象', () => {
  const { canvas, received, requests } = installDiagOnFakeScope({
    desynchronized: true,
    powerPreference: 'low-power',
  });
  const webgl = {
    alpha: true,
    desynchronized: false,
    powerPreference: 'high-performance',
  };
  canvas.getContext('webgl2', webgl);
  assert.deepEqual(plain(received[0].attrs), {
    alpha: true,
    desynchronized: true,
    powerPreference: 'low-power',
  });
  assert.equal(webgl.desynchronized, false, '原对象不应被改写');
  // 2D 上下文没有 powerPreference：不凭空添加
  canvas.getContext('2d', { alpha: true, desynchronized: false });
  assert.deepEqual(plain(received[1].attrs), {
    alpha: true,
    desynchronized: true,
  });
  assert.deepEqual(
    requests().map((request) => request.desynchronized),
    [true, true],
  );
});

test('诊断拦截器：每次调用时才读取开关（Worker 要到 init 才知道它们）', () => {
  const { scope, canvas, received } = installDiagOnFakeScope(undefined);
  canvas.getContext('webgl2', { desynchronized: false });
  assert.equal(received[0].attrs?.desynchronized, false, '尚未下发开关时透传');
  scope.__SMARTSUB_JASSUB_DIAG__ = { desynchronized: true };
  canvas.getContext('webgl2', { desynchronized: false });
  assert.equal(received[1].attrs?.desynchronized, true, '开关下发后生效');
});

test('诊断拦截器不重复安装，也不在没有 OffscreenCanvas 的环境里抛错', () => {
  assert.equal(installDiagInterposer({}), false);
  const { scope } = installDiagOnFakeScope({});
  const installed = scope.OffscreenCanvas!.prototype.getContext;
  assert.equal(installDiagInterposer(scope), false);
  assert.equal(scope.OffscreenCanvas!.prototype.getContext, installed);
});

type WorkerGlobalName =
  | 'OffscreenCanvas'
  | 'navigator'
  | '__SMARTSUB_JASSUB_DIAG__'
  | '__SMARTSUB_JASSUB_REQUESTS__';

/**
 * 按真实接线加载 renderer/lib/jassub/workerGuard.ts（loader 注入进 JASSUB Worker 入口的那个模块），
 * 在假的 Worker 全局里观察原生 getContext 最终收到什么。
 */
function inWorker<T>(
  userAgent: string,
  diag: Record<string, unknown>,
  run: (worker: {
    canvas: FakeCanvas;
    received: ContextCall[];
    requests: () => Array<Record<string, unknown>>;
  }) => T,
): T {
  const names: WorkerGlobalName[] = [
    'OffscreenCanvas',
    'navigator',
    '__SMARTSUB_JASSUB_DIAG__',
    '__SMARTSUB_JASSUB_REQUESTS__',
  ];
  const saved = names.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const define = (name: WorkerGlobalName, value: unknown) =>
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  const { FakeOffscreenCanvas, received } = createFakeCanvasClass();
  define('OffscreenCanvas', FakeOffscreenCanvas);
  define('navigator', { userAgent });
  define('__SMARTSUB_JASSUB_DIAG__', diag);
  const guardModule = require.resolve('../../renderer/lib/jassub/workerGuard');
  delete require.cache[guardModule];
  try {
    require(guardModule);
    return run({
      canvas: new FakeOffscreenCanvas(),
      received,
      requests: () =>
        plain(
          (globalThis as unknown as Record<string, unknown>)
            .__SMARTSUB_JASSUB_REQUESTS__ as Array<Record<string, unknown>>,
        ),
    });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  }
}

test('workerGuard 接线：诊断拦截器在守卫里面，所以默认走修复、强制 true 仍能复现 3.9.0', () => {
  const rendererRequest = {
    alpha: true,
    desynchronized: true,
    powerPreference: 'high-performance',
  };
  const nativeDesync = (
    userAgent: string,
    diag: Record<string, unknown>,
  ): [unknown, unknown] =>
    inWorker(userAgent, diag, ({ canvas, received, requests }) => {
      canvas.getContext('webgl2', rendererRequest);
      return [
        received.at(-1)?.attrs?.desynchronized,
        requests().at(-1)?.desynchronized,
      ];
    });

  assert.deepEqual(
    nativeDesync(WINDOWS_UA, {}),
    [false, false],
    'Windows 默认（修复）',
  );
  assert.deepEqual(
    nativeDesync(MAC_UA, {}),
    [true, true],
    '其它平台保持上游行为',
  );
  assert.deepEqual(
    nativeDesync(WINDOWS_UA, { desynchronized: true }),
    [true, true],
    '强制 true 越过守卫，原生收到 true（复现 3.9.0）',
  );
  assert.deepEqual(nativeDesync(WINDOWS_UA, { desynchronized: false }), [
    false,
    false,
  ]);
  assert.deepEqual(nativeDesync(MAC_UA, { desynchronized: false }), [
    false,
    false,
  ]);
  assert.equal(
    rendererRequest.desynchronized,
    true,
    '渲染器传入的对象不应被改写',
  );
});

// ───────────── 运行 ─────────────

async function main() {
  let failed = 0;
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(
        `FAIL ${name}\n${error instanceof Error ? error.stack : error}`,
      );
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}

void main();
