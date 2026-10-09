import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_RETENTION_DAYS,
  buildBundleEntries,
  buildIssueUrl,
  buildSettingsSnapshot,
  collectDiagnosticsInput,
  describePathSetting,
  diagnosticsFileName,
  formatStamp,
  previewDiagnostics,
  sanitizeEventsJsonl,
  sanitizeLogJsonl,
  writeZipFile,
  type DiagnosticsSources,
} from '../../main/helpers/crash/diagnosticsBundle';
import { createPathRedactor } from '../../main/helpers/crash/crashEvents';
import { summarizeMinidumpFile } from '../../main/helpers/crash/minidumpSummary';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

// 仓库里其它地方也是这样引入的；它没有类型声明，测试里按 any 用即可
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decompress = require('decompress') as (
  input: string,
) => Promise<Array<{ path: string; data: Buffer; type: string }>>;

const HOME = '/Users/alice';
const SECRET = 'sk-abcdefghijklmnop1234';
const NOW = new Date(2026, 9, 9, 15, 30, 12).getTime();

/** 与真实 sanitizeLogMessage 同一契约：把形如 apiKey: "xxx" 的值遮住。 */
const sanitize = (text: string) =>
  text.replace(/(apiKey["']?\s*[:=]\s*["'])[^"']+/gi, '$1sk-****');
const redact = createPathRedactor([HOME]);
const options = { sanitize, redact };

function logLine(message: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: 1, message, type: 'info', ...extra });
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-diag-'));
  tmpDirs.push(dir);
  return dir;
}

function writeDump(dir: string, name: string, exceptionCode: number) {
  const file = path.join(dir, name);
  const buffer = buildMinidump({
    os: 'windows',
    arch: 'x64',
    cpu: { family: 6, model: 58, stepping: 9 },
    modules: [{ name: `${HOME}\\addon.node`, base: 0x10000n, size: 0x5000 }],
    exception: { code: exceptionCode, address: 0x10100n },
  });
  fs.writeFileSync(file, buffer);
  return { file, size: buffer.length, mtimeMs: NOW - 1000, buffer };
}

function makeSources(
  dir: string,
  overrides: Partial<DiagnosticsSources> = {},
): DiagnosticsSources & { dumps: ReturnType<typeof writeDump>[] } {
  const dumps = [
    writeDump(dir, 'aaaa-1111.dmp', 0xc000001d),
    writeDump(dir, 'bbbb-2222.dmp', 0xc0000005),
  ];
  const logs: Record<string, string> = {
    '2026-10-09': [
      logLine(`start ${HOME}/Movies/a.mp4`),
      logLine(`call failed apiKey: "${SECRET}" for provider`),
      '{"timestamp":2,"message":"cut off by a cr',
    ].join('\n'),
    '2026-10-08': logLine('older day'),
  };
  const events = JSON.stringify({
    ts: 5,
    source: 'child-process-gone',
    detail: `at ${HOME}/x apiKey: "${SECRET}"`,
    context: [{ engine: 'builtin', model: 'ggml-tiny.bin' }],
  });
  return {
    dumps,
    now: NOW,
    appVersion: '4.1.0',
    crashReporterEnabled: true,
    listLogFiles: async () => [
      { date: '2026-10-09', size: logs['2026-10-09'].length },
      { date: '2026-10-08', size: logs['2026-10-08'].length },
    ],
    readLog: async (date) =>
      logs[date]
        ? { text: logs[date], truncated: date === '2026-10-08' }
        : null,
    readCrashEvents: async () => ({ current: `${events}\n`, rotated: null }),
    listDumps: () =>
      dumps.map((d) => ({ file: d.file, size: d.size, mtimeMs: d.mtimeMs })),
    summarizeDump: (file) => summarizeMinidumpFile(file),
    system: async () => ({
      os: { platform: 'win32' },
      cpu: { model: 'Fake CPU' },
    }),
    gpu: async () => ({ gpus: [{ name: 'GTX 1060' }], where: `${HOME}\\gpu` }),
    settings: () => ({
      settings: {
        gpuMode: 'auto',
        useVAD: true,
        proxyUrl: `http://user:${SECRET}@proxy:8080`,
        customTempDir: `${HOME}/临时`,
        translationProviders: [{ apiKey: SECRET }],
        storageRoot: 'D:\\模型',
      },
      userConfig: { model: 'tiny', sourceLanguage: 'en', apiKey: SECRET },
    }),
    addon: () => ({
      active: { backend: 'cpu' },
      history: [
        { backend: 'cuda', path: `${HOME}/addons/addon.node`, success: false },
      ],
    }),
    ...overrides,
  };
}

async function zipEntries(file: string) {
  const files = await decompress(file);
  const byName = new Map(
    files.filter((f) => f.type === 'file').map((f) => [f.path, f.data]),
  );
  return byName;
}

async function main() {
  await test('文件名与时间戳按本地时区格式化', () => {
    assert.equal(formatStamp(NOW), '20261009-153012');
    assert.equal(
      diagnosticsFileName(NOW),
      'smartsub-diagnostics-20261009-153012.zip',
    );
  });

  await test('设置快照只含白名单；对象、凭据、路径与代理地址都不会出现', () => {
    const snapshot = buildSettingsSnapshot(
      {
        gpuMode: 'auto',
        language: 'zh',
        useVAD: true,
        vadThreshold: 0.5,
        proxyMode: 'custom',
        proxyUrl: `http://user:${SECRET}@proxy:8080`,
        customTempDir: '/Users/alice/临时',
        storageRoot: 'D:\\模型 库',
        selectedCudaDevice: 'GPU-123',
        translationProviders: [{ apiKey: SECRET }],
        // 白名单键下夹带对象也要丢弃
        funasrProvider: { apiKey: SECRET },
        lastUsedTranscription: {
          engine: 'builtin',
          model: 'tiny',
          asrProviderId: 'p1',
        },
      },
      {
        model: 'small',
        sourceLanguage: 'en',
        manuscriptPath: '/Users/alice/a.txt',
        apiKey: SECRET,
      },
    );
    const text = JSON.stringify(snapshot);
    for (const leaked of [
      SECRET,
      'alice',
      'proxy:8080',
      'GPU-123',
      'p1',
      '模型',
      '临时',
    ]) {
      assert.ok(!text.includes(leaked), `不应出现 ${leaked}`);
    }
    const s = snapshot.settings as Record<string, unknown>;
    assert.equal(s.gpuMode, 'auto');
    assert.equal(s.vadThreshold, 0.5);
    assert.equal(s.proxyMode, 'custom');
    assert.equal(s.funasrProvider, undefined);
    const paths = snapshot.pathSettings as Record<string, any>;
    assert.deepEqual(paths.customTempDir, {
      set: true,
      nonAscii: true,
      hasSpace: false,
    });
    assert.deepEqual(paths.storageRoot, {
      set: true,
      nonAscii: true,
      hasSpace: true,
    });
    assert.deepEqual(paths.modelsPath, {
      set: false,
      nonAscii: false,
      hasSpace: false,
    });
    assert.deepEqual(snapshot.lastUsedTranscription, {
      engine: 'builtin',
      model: 'tiny',
    });
    assert.deepEqual(snapshot.lastTaskConfig, {
      model: 'small',
      sourceLanguage: 'en',
    });
  });

  await test('设置快照：缺失或类型错误的输入不抛错', () => {
    for (const bad of [null, undefined, 'x', 42, [], [1]]) {
      const snapshot = buildSettingsSnapshot(bad, bad);
      assert.deepEqual(snapshot.settings, {});
      assert.deepEqual(snapshot.lastTaskConfig, {});
    }
    assert.deepEqual(describePathSetting(undefined), {
      set: false,
      nonAscii: false,
      hasSpace: false,
    });
    assert.deepEqual(describePathSetting('   '), {
      set: false,
      nonAscii: false,
      hasSpace: false,
    });
    assert.deepEqual(describePathSetting('C:\\a b'), {
      set: true,
      nonAscii: false,
      hasSpace: true,
    });
  });

  await test('应用日志：逐行脱敏并保持一行一条；坏行保留并折成单行', () => {
    const input = [
      logLine(`open ${HOME}/a.mp4`),
      logLine(`apiKey: "${SECRET}"`),
      '',
      '{"timestamp":3,"message":"half written',
      '   ',
      JSON.stringify({ not: 'a log entry', path: `${HOME}/x` }),
    ].join('\n');
    const out = sanitizeLogJsonl(input, options);
    const lines = out.split('\n').filter(Boolean);
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[0]).message, 'open ~/a.mp4');
    assert.ok(!out.includes(SECRET));
    assert.ok(!out.includes('alice'));
    // 除了最后一个换行，没有多余的换行（多行会破坏 JSONL）
    assert.ok(out.endsWith('\n'));
    assert.equal(out.split('\n').length, 5);
    assert.equal(sanitizeLogJsonl('', options), '');
  });

  await test('日志脱敏函数展开成多行时，结果仍是单行 JSON', () => {
    const multiline = (text: string) => text.replace('X', 'a\nb\nc');
    const out = sanitizeLogJsonl(logLine('X'), { sanitize: multiline, redact });
    assert.equal(out.split('\n').filter(Boolean).length, 1);
    assert.equal(JSON.parse(out.trim()).message, 'a\nb\nc');
  });

  await test('崩溃事件：嵌套字符串里的凭据与用户目录都被处理，行数被统计', () => {
    const { text, lines } = sanitizeEventsJsonl(
      [
        JSON.stringify({
          ts: 1,
          detail: `${HOME}/x apiKey: "${SECRET}"`,
          context: [{ model: `${HOME}/m.bin` }],
        }),
        'garbage {',
      ].join('\n'),
      options,
    );
    assert.equal(lines, 2);
    assert.ok(!text.includes('alice'));
    assert.ok(!text.includes(SECRET));
    assert.ok(text.includes('~/m.bin'));
  });

  await test('完整往返：收集 → 拼装 → 写 zip → 解开，内容与隐私边界都对', async () => {
    const dir = tmp();
    const sources = makeSources(dir);
    const input = await collectDiagnosticsInput(sources);
    const { root, entries, manifest } = buildBundleEntries(input, {
      includeRawDumps: false,
      ...options,
    });
    const target = path.join(dir, 'out', 'bundle.zip');
    const bytes = await writeZipFile(target, entries);
    assert.equal(bytes, fs.statSync(target).size);
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)),
      ['bundle.zip'],
      '不应留下临时文件',
    );

    const files = await zipEntries(target);
    const names = [...files.keys()].sort();
    assert.deepEqual(names, [
      `${root}/README.txt`,
      `${root}/addon.json`,
      `${root}/crash/crash-events.jsonl`,
      `${root}/crash/dump-summaries.json`,
      `${root}/gpu.json`,
      `${root}/logs/2026-10-08.jsonl`,
      `${root}/logs/2026-10-09.jsonl`,
      `${root}/manifest.json`,
      `${root}/settings.json`,
      `${root}/system.json`,
    ]);

    // 默认不带原始转储，但摘要始终在
    assert.ok(!names.some((n) => n.endsWith('.dmp')));
    const summaries = JSON.parse(
      files.get(`${root}/crash/dump-summaries.json`)!.toString(),
    );
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].summary.exception.name, 'ILLEGAL_INSTRUCTION');
    assert.equal(summaries[0].summary.faultModule.name, 'addon.node');
    assert.equal(summaries[1].summary.exception.name, 'ACCESS_VIOLATION');
    assert.equal(summaries[0].name, 'aaaa-1111.dmp');

    // 隐私：所有文本里都没有凭据、用户名、代理地址、自定义路径
    for (const [name, data] of files) {
      const text = data.toString();
      for (const leaked of [SECRET, 'alice', 'proxy:8080', '临时', '模型']) {
        assert.ok(!text.includes(leaked), `${name} 不应包含 ${leaked}`);
      }
    }
    assert.ok(
      files
        .get(`${root}/logs/2026-10-09.jsonl`)!
        .toString()
        .includes('~/Movies/a.mp4'),
    );
    assert.ok(
      files
        .get(`${root}/addon.json`)!
        .toString()
        .includes('~/addons/addon.node'),
    );
    assert.ok(files.get(`${root}/gpu.json`)!.toString().includes('~'));

    // 清单与实际内容一致
    const parsed = JSON.parse(files.get(`${root}/manifest.json`)!.toString());
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(manifest)));
    assert.equal(parsed.appVersion, '4.1.0');
    assert.deepEqual(parsed.logDays, ['2026-10-09', '2026-10-08']);
    assert.deepEqual(parsed.logsTruncated, ['2026-10-08']);
    assert.equal(parsed.crashEventLines, 1);
    assert.equal(parsed.dumpSummaries, 2);
    assert.deepEqual(parsed.rawDumps, []);
    assert.deepEqual(parsed.collectErrors, []);
    for (const file of parsed.files) {
      const data = files.get(`${root}/${file.name}`);
      assert.ok(data, file.name);
      assert.equal(data.length, file.bytes, file.name);
    }

    // 设置只含白名单
    const settings = JSON.parse(files.get(`${root}/settings.json`)!.toString());
    assert.equal(settings.settings.gpuMode, 'auto');
    assert.equal(settings.settings.proxyUrl, undefined);
  });

  await test('勾选后附带原始转储：字节与原文件一致，名称安全', async () => {
    const dir = tmp();
    const sources = makeSources(dir);
    const input = await collectDiagnosticsInput(sources);
    // 构造一个带路径分隔符与怪字符的名字，条目名里不能出现目录穿越
    input.dumps[0] = { ...input.dumps[0], name: '..\\..\\evil name.dmp' };
    const { root, entries, manifest } = buildBundleEntries(input, {
      includeRawDumps: true,
      ...options,
    });
    const target = path.join(dir, 'with-dumps.zip');
    await writeZipFile(target, entries);
    const files = await zipEntries(target);
    const dumpNames = [...files.keys()]
      .filter((n) => n.endsWith('.dmp'))
      .sort();
    assert.equal(dumpNames.length, 2);
    for (const name of dumpNames) {
      assert.ok(name.startsWith(`${root}/crash/dumps/`), name);
      assert.ok(!name.slice(`${root}/crash/dumps/`.length).includes('/'), name);
      assert.ok(!name.includes('..'.concat('/')), name);
    }
    const second = files.get(`${root}/crash/dumps/bbbb-2222.dmp`);
    assert.ok(second);
    assert.ok(second.equals(sources.dumps[1].buffer));
    assert.equal(manifest.rawDumps.length, 2);
  });

  await test('某一部分收集失败：其余照常导出，清单与 warnings 里能看到原因', async () => {
    const dir = tmp();
    const sources = makeSources(dir, {
      gpu: async () => {
        throw new Error('gpu detection timed out');
      },
      system: () => {
        throw new Error(`boom at ${HOME}/x`);
      },
      readLog: async (date) => {
        if (date === '2026-10-08') throw new Error('EIO');
        return { text: logLine('ok day'), truncated: false };
      },
      readCrashEvents: async () => {
        throw new Error('events unreadable');
      },
      summarizeDump: () => {
        throw new Error('bad dump');
      },
    });
    const input = await collectDiagnosticsInput(sources);
    const { root, entries, manifest } = buildBundleEntries(input, {
      includeRawDumps: false,
      ...options,
    });
    const target = path.join(dir, 'partial.zip');
    await writeZipFile(target, entries);
    const files = await zipEntries(target);

    assert.deepEqual(manifest.logDays, ['2026-10-09']);
    assert.ok(!files.has(`${root}/crash/crash-events.jsonl`));
    assert.equal(
      JSON.parse(files.get(`${root}/gpu.json`)!.toString()).error,
      'gpu detection timed out',
    );
    assert.ok(
      files.get(`${root}/system.json`)!.toString().includes('boom at ~/x'),
    );
    assert.ok(files.has(`${root}/settings.json`));
    const joined = manifest.collectErrors.join('\n');
    for (const part of [
      'gpu:',
      'system:',
      'crashEvents:',
      'logs 2026-10-08:',
      'dump aaaa-1111.dmp:',
    ]) {
      assert.ok(joined.includes(part), part);
    }
    // 摘要失败的转储仍然列出，只是 summary 为 null
    const summaries = JSON.parse(
      files.get(`${root}/crash/dump-summaries.json`)!.toString(),
    );
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].summary, null);
    // 清单里的错误信息也经过脱敏
    assert.ok(!joined.includes('alice'));
  });

  await test('日志列表本身读不到：不影响其它部分', async () => {
    const dir = tmp();
    const input = await collectDiagnosticsInput(
      makeSources(dir, {
        listLogFiles: async () => {
          throw new Error('logs dir missing');
        },
      }),
    );
    assert.deepEqual(input.logs, []);
    assert.ok(input.collectErrors[0].startsWith('logs:'));
    assert.equal(input.dumps.length, 2);
  });

  await test(`日志最多取最近 ${LOG_RETENTION_DAYS} 天`, async () => {
    const dir = tmp();
    const dates = Array.from(
      { length: 10 },
      (_, i) => `2026-10-${String(10 - i).padStart(2, '0')}`,
    );
    const read: string[] = [];
    const input = await collectDiagnosticsInput(
      makeSources(dir, {
        listLogFiles: async () => dates.map((date) => ({ date, size: 1 })),
        readLog: async (date) => {
          read.push(date);
          return { text: logLine(date), truncated: false };
        },
      }),
    );
    assert.equal(input.logs.length, LOG_RETENTION_DAYS);
    assert.deepEqual(read, dates.slice(0, LOG_RETENTION_DAYS));
  });

  await test('导出时转储已被清理：写 zip 失败，不留半个文件，也不触发未捕获异常', async () => {
    const dir = tmp();
    const sources = makeSources(dir);
    const input = await collectDiagnosticsInput(sources);
    fs.rmSync(sources.dumps[0].file);
    const { entries } = buildBundleEntries(input, {
      includeRawDumps: true,
      ...options,
    });
    const target = path.join(dir, 'broken', 'bundle.zip');
    await assert.rejects(writeZipFile(target, entries), /ENOENT/);
    assert.ok(!fs.existsSync(target));
    const leftovers = fs.existsSync(path.dirname(target))
      ? fs.readdirSync(path.dirname(target))
      : [];
    assert.deepEqual(leftovers, []);
  });

  await test('预览：日志天数与体积、事件条数、转储的异常名与故障模块', async () => {
    const dir = tmp();
    const sources = makeSources(dir);
    const preview = await previewDiagnostics(sources);
    assert.equal(preview.logDays, 2);
    assert.ok(preview.logBytes > 0);
    assert.equal(preview.crashEventCount, 1);
    assert.equal(preview.dumps.length, 2);
    assert.deepEqual(preview.dumps[0], {
      name: 'aaaa-1111.dmp',
      size: sources.dumps[0].size,
      mtimeMs: sources.dumps[0].mtimeMs,
      exception: 'ILLEGAL_INSTRUCTION',
      faultModule: 'addon.node',
    });
    assert.equal(
      preview.dumpBytes,
      sources.dumps[0].size + sources.dumps[1].size,
    );
    assert.equal(preview.crashReporterEnabled, true);
    assert.equal(
      preview.suggestedFileName,
      'smartsub-diagnostics-20261009-153012.zip',
    );
  });

  await test('预览：任何来源失败都当作“没有”，不抛错', async () => {
    const dir = tmp();
    const preview = await previewDiagnostics(
      makeSources(dir, {
        crashReporterEnabled: false,
        listLogFiles: async () => {
          throw new Error('x');
        },
        readCrashEvents: async () => {
          throw new Error('x');
        },
        listDumps: () => {
          throw new Error('x');
        },
      }),
    );
    assert.equal(preview.logDays, 0);
    assert.equal(preview.logBytes, 0);
    assert.equal(preview.crashEventCount, 0);
    assert.deepEqual(preview.dumps, []);
    assert.equal(preview.crashReporterEnabled, false);
  });

  await test('预填 issue：只含环境摘要，不含日志；参数能被还原；长字段被截断', () => {
    const url = buildIssueUrl(
      {
        appVersion: '4.1.0',
        os: 'win32 10.0.19045 (x64)',
        cpuModel: 'Intel(R) Xeon(R) CPU E3-1230 V2',
        gpuNames: ['GTX 1060'],
        latestCrash: 'illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)',
      },
      'zh',
    );
    const parsed = new URL(url);
    assert.equal(
      parsed.origin + parsed.pathname,
      'https://github.com/buxuku/SmartSub/issues/new',
    );
    assert.equal(parsed.searchParams.get('title'), '闪退反馈');
    const body = parsed.searchParams.get('body') ?? '';
    for (const expected of [
      'SmartSub: 4.1.0',
      'win32 10.0.19045 (x64)',
      'E3-1230 V2',
      'GTX 1060',
      '0xC000001D',
      '诊断包',
    ]) {
      assert.ok(body.includes(expected), expected);
    }

    const en =
      new URL(
        buildIssueUrl(
          {
            appVersion: '1',
            os: 'x',
            cpuModel: null,
            gpuNames: [],
            latestCrash: null,
          },
          'en',
        ),
      ).searchParams.get('body') ?? '';
    assert.ok(en.includes('Environment'));
    assert.ok(en.includes('CPU: unknown'));
    assert.ok(!en.includes('GPU:'));
    assert.ok(!en.includes('Latest crash'));

    const long = buildIssueUrl(
      {
        appVersion: '1',
        os: 'x'.repeat(5000),
        cpuModel: 'y'.repeat(5000),
        gpuNames: ['z'.repeat(5000)],
        latestCrash: 'w'.repeat(5000),
      },
      'en',
    );
    assert.ok(long.length < 2500, `URL 过长：${long.length}`);
  });

  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  finish('diagnostics');
}

main();
