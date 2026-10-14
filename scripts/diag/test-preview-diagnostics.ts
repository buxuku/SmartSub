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

// ───────────── 默认开关 = 3.9.0 ─────────────

test('默认开关与 3.9.0 的行为一致（守护测试）', () => {
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
  assert.match(
    fs.readFileSync(
      path.join(copy, 'dist/worker/renderers/webgl2-renderer.js'),
      'utf8',
    ),
    /desynchronized: \(globalThis/,
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
  // 锚点被破坏时拒绝打补丁，且不留下半成品
  const broken = path.join(copy, 'dist/worker/renderers/webgl1-renderer.js');
  fs.writeFileSync(
    broken,
    original['dist/worker/renderers/webgl1-renderer.js'].replace(
      'desynchronized: true,',
      'desynchronized: false,',
    ),
  );
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /expected exactly 1 anchor/);
  assert.equal(
    fs.readFileSync(path.join(copy, 'dist/worker/worker.js'), 'utf8'),
    original['dist/worker/worker.js'],
    '失败时其它文件不应被改动',
  );
  fs.rmSync(copy, { recursive: true, force: true });
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
