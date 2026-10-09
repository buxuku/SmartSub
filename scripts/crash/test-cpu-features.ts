import {
  WINDOWS_MIN_BUILD_FOR_AVX_PROBE,
  WINDOWS_PROBE_TIMEOUT_MS,
  buildWindowsProbeCommand,
  detectCpuFeatures,
  featuresFromProcFlags,
  parseCpuCache,
  parseSysctlBool,
  parseWindowsProbeOutput,
  toAdvisory,
  unknownFeatures,
  windowsBuildOf,
  type CpuFeatureCacheEntry,
  type CpuProbeDeps,
} from '../../main/helpers/crash/cpuFeatures';
import { assert, finish, test } from './testkit';

const FULL_FLAGS = 'fpu sse4_2 avx avx2 fma f16c bmi2 avx512f';
// Ivy Bridge 形态：有 AVX / F16C，没有 AVX2 / FMA / BMI2（QEMU 里实测会崩）
const IVY_FLAGS = 'fpu sse4_2 avx f16c';
// 无 AVX 的低端 CPU 形态
const CELERON_FLAGS = 'fpu sse4_2 aes';

const cpuinfo = (flags: string) =>
  `processor\t: 0\nmodel name\t: Test CPU @ 3.00GHz\nflags\t\t: ${flags}\n`;

interface Calls {
  readFile: string[];
  sysctl: string[];
  run: Array<{ file: string; args: string[]; timeoutMs: number }>;
  cacheWrites: CpuFeatureCacheEntry[];
}

function makeDeps(
  overrides: Partial<CpuProbeDeps> = {},
  state: { cache?: CpuFeatureCacheEntry | null; clock?: number[] } = {},
): { deps: CpuProbeDeps; calls: Calls } {
  const calls: Calls = { readFile: [], sysctl: [], run: [], cacheWrites: [] };
  const clock = state.clock ?? [1000, 1000, 1000, 1000];
  const deps: CpuProbeDeps = {
    platform: 'linux',
    arch: 'x64',
    translated: false,
    osRelease: '6.8.0',
    cpuModel: 'Test CPU',
    readFile: async (file) => {
      calls.readFile.push(file);
      return null;
    },
    sysctl: async (key) => {
      calls.sysctl.push(key);
      return null;
    },
    run: async (file, args, timeoutMs) => {
      calls.run.push({ file, args, timeoutMs });
      return null;
    },
    cache: {
      read: () => state.cache ?? null,
      write: (entry) => {
        calls.cacheWrites.push(entry);
      },
    },
    now: () => clock.shift() ?? 1000,
    ...overrides,
  };
  return { deps, calls };
}

async function main() {
  await test('Linux：/proc/cpuinfo 的 flags 逐项对应；全有时全是 true', async () => {
    const { deps } = makeDeps({ readFile: async () => cpuinfo(FULL_FLAGS) });
    const report = await detectCpuFeatures(deps);
    assert.equal(report.source, 'proc-cpuinfo');
    assert.deepEqual(report.features, {
      avx: true,
      avx2: true,
      fma: true,
      f16c: true,
      bmi2: true,
    });
    assert.deepEqual(toAdvisory(report, 'linux').missing, []);
  });

  await test('Linux：Ivy Bridge 形态明确缺 AVX2 / FMA / BMI2，有的不算缺', async () => {
    const { deps } = makeDeps({ readFile: async () => cpuinfo(IVY_FLAGS) });
    const advisory = toAdvisory(await detectCpuFeatures(deps), 'linux');
    assert.deepEqual(advisory.missing, ['avx2', 'fma', 'bmi2']);
    assert.deepEqual(advisory.unknown, []);
  });

  await test('Linux：没有 AVX 的 CPU 五项全缺', async () => {
    const { deps } = makeDeps({ readFile: async () => cpuinfo(CELERON_FLAGS) });
    const advisory = toAdvisory(await detectCpuFeatures(deps), 'linux');
    assert.deepEqual(advisory.missing, ['avx', 'avx2', 'fma', 'f16c', 'bmi2']);
  });

  await test('Linux：读不到 /proc/cpuinfo 或没有 flags 行是 unknown，绝不当成“没有”', async () => {
    for (const read of [
      async () => null,
      async () => 'processor\t: 0\nmodel name\t: X\n',
      async () => {
        throw new Error('EACCES');
      },
    ]) {
      const { deps } = makeDeps({ readFile: read });
      const report = await detectCpuFeatures(deps);
      assert.deepEqual(report.features, unknownFeatures());
      assert.ok(report.note);
      const advisory = toAdvisory(report, 'linux');
      assert.deepEqual(advisory.missing, []);
      assert.equal(advisory.unknown.length, 5);
    }
  });

  await test('featuresFromProcFlags：空列表是全 unknown；flags 名按精确匹配（avx2 不会被 avx 命中）', () => {
    assert.deepEqual(featuresFromProcFlags([]), unknownFeatures());
    const only = featuresFromProcFlags(['avx']);
    assert.equal(only.avx, true);
    assert.equal(only.avx2, false);
  });

  await test('macOS Intel：sysctl 的 1 / 0 / 缺失分别是 有 / 没有 / unknown', async () => {
    const values: Record<string, string | null> = {
      'hw.optional.avx1_0': '1',
      'hw.optional.avx2_0': '0',
      'hw.optional.fma': '1',
      'hw.optional.f16c': null,
      'hw.optional.bmi2': 'garbage',
    };
    const asked: string[] = [];
    const { deps } = makeDeps({
      platform: 'darwin',
      sysctl: async (key) => {
        asked.push(key);
        return values[key] ?? null;
      },
    });
    const report = await detectCpuFeatures(deps);
    assert.equal(report.source, 'sysctl');
    assert.deepEqual(report.features, {
      avx: true,
      avx2: false,
      fma: true,
      f16c: null,
      bmi2: null,
    });
    const advisory = toAdvisory(report, 'darwin');
    assert.deepEqual(advisory.missing, ['avx2']);
    assert.deepEqual(advisory.unknown, ['f16c', 'bmi2']);
    assert.deepEqual(asked.sort(), Object.keys(values).sort());
  });

  await test('macOS：sysctl 全读不出来是 unknown 并带说明，不抛错', async () => {
    const { deps } = makeDeps({
      platform: 'darwin',
      sysctl: async () => {
        throw new Error('spawn failed');
      },
    });
    const report = await detectCpuFeatures(deps);
    assert.deepEqual(report.features, unknownFeatures());
    assert.ok(report.note);
  });

  await test('parseSysctlBool：只有 1 与 0 有含义', () => {
    assert.equal(parseSysctlBool('1\n'), true);
    assert.equal(parseSysctlBool('0'), false);
    assert.equal(parseSysctlBool('2'), null);
    assert.equal(parseSysctlBool(''), null);
    assert.equal(parseSysctlBool(null), null);
  });

  await test('arm64：门槛不适用，什么都不读不跑', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { deps, calls } = makeDeps({ platform, arch: 'arm64' });
      const report = await detectCpuFeatures(deps);
      assert.equal(report.applicable, false);
      assert.equal(report.source, 'not-applicable');
      assert.deepEqual(calls.readFile, []);
      assert.deepEqual(calls.sysctl, []);
      assert.deepEqual(calls.run, []);
      const advisory = toAdvisory(report, platform);
      assert.deepEqual(advisory.missing, []);
      assert.deepEqual(advisory.unknown, []);
    }
  });

  await test('x64 进程在 ARM 转译下：不探测、不判缺失，只标记 translated', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { deps, calls } = makeDeps({
        platform,
        translated: true,
        osRelease: '10.0.22631',
        // 就算读到了也不可信：这里故意给“全没有”，结论里不能出现缺失
        readFile: async () => cpuinfo(CELERON_FLAGS),
        sysctl: async () => '0',
        run: async () => '39=False\n40=False\n',
      });
      const report = await detectCpuFeatures(deps);
      assert.equal(report.translated, true);
      assert.equal(report.source, 'translated');
      assert.deepEqual(calls.readFile, []);
      assert.deepEqual(calls.sysctl, []);
      assert.deepEqual(calls.run, []);
      const advisory = toAdvisory(report, platform);
      assert.equal(advisory.translated, true);
      assert.deepEqual(advisory.missing, []);
    }
  });

  await test('Windows：解析 PowerShell 输出；AVX2 为 False 才算缺失，FMA / F16C / BMI2 一律 unknown', async () => {
    const { deps, calls } = makeDeps(
      {
        platform: 'win32',
        osRelease: '10.0.19045',
        run: async (file, args, timeoutMs) => {
          calls.run.push({ file, args, timeoutMs });
          return 'some compiler warning\r\n39=True\r\n40=False\r\n';
        },
      },
      { clock: [100, 2100, 2100] },
    );
    const report = await detectCpuFeatures(deps);
    assert.equal(report.source, 'win32-ipf');
    assert.equal(report.detectMs, 2000);
    assert.deepEqual(report.features, {
      avx: true,
      avx2: false,
      fma: null,
      f16c: null,
      bmi2: null,
    });
    const advisory = toAdvisory(report, 'win32');
    assert.deepEqual(advisory.missing, ['avx2']);
    assert.deepEqual(advisory.unknown, ['fma', 'f16c', 'bmi2']);
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].timeoutMs, WINDOWS_PROBE_TIMEOUT_MS);
  });

  await test('Windows：AVX2 为 True 时没有缺失，也不会因为 FMA 等查不到而预警', async () => {
    const { deps } = makeDeps({
      platform: 'win32',
      osRelease: '10.0.22631',
      run: async () => '39=True\n40=True\n',
    });
    const advisory = toAdvisory(await detectCpuFeatures(deps), 'win32');
    assert.deepEqual(advisory.missing, []);
    assert.deepEqual(advisory.unknown, ['fma', 'f16c', 'bmi2']);
  });

  await test('Windows：构建号低于 19041（或读不出）时系统可能不认识 AVX 常量，不探测、不判缺失', async () => {
    for (const osRelease of ['10.0.19040', '10.0.18363', '6.1.7601', 'weird']) {
      const { deps, calls } = makeDeps({
        platform: 'win32',
        osRelease,
        run: async () => '39=False\n40=False\n',
      });
      const report = await detectCpuFeatures(deps);
      assert.deepEqual(report.features, unknownFeatures(), osRelease);
      assert.deepEqual(calls.run, [], osRelease);
      assert.deepEqual(toAdvisory(report, 'win32').missing, [], osRelease);
    }
    const boundary = makeDeps({
      platform: 'win32',
      osRelease: `10.0.${WINDOWS_MIN_BUILD_FOR_AVX_PROBE}`,
      run: async () => '39=True\n40=True\n',
    });
    const report = await detectCpuFeatures(boundary.deps);
    assert.equal(report.features.avx2, true);
  });

  await test('Windows：探测失败时 note 带着原因（超时 / 起不来），拿不到原因时保持旧文案', async () => {
    const cases: Array<[() => Promise<string | null>, string]> = [
      [
        async () => {
          throw new Error('timed out after 30000 ms');
        },
        'powershell probe failed: timed out after 30000 ms',
      ],
      [
        async () => {
          throw new Error('exit code 1:\r\n  Add-Type : blocked  ');
        },
        'powershell probe failed: exit code 1: Add-Type : blocked',
      ],
      [async () => null, 'powershell probe failed or timed out'],
    ];
    for (const [run, note] of cases) {
      const { deps } = makeDeps({
        platform: 'win32',
        osRelease: '10.0.19045',
        run,
      });
      const report = await detectCpuFeatures(deps);
      assert.equal(report.source, 'unavailable');
      assert.equal(report.note, note);
    }
    // 原因很长也只留一小段，报告会进诊断包
    const long = makeDeps({
      platform: 'win32',
      osRelease: '10.0.19045',
      run: async () => {
        throw new Error('x'.repeat(5000));
      },
    });
    const note = (await detectCpuFeatures(long.deps)).note ?? '';
    assert.ok(note.length < 300, `note 长度 ${note.length}`);
  });

  await test('Windows：探测失败、超时、输出乱码都是 unknown，不缓存，不抛错', async () => {
    for (const run of [
      async () => null,
      async () => {
        throw new Error('spawn ENOENT');
      },
      async () => 'Add-Type : constrained language mode',
    ]) {
      const { deps, calls } = makeDeps({
        platform: 'win32',
        osRelease: '10.0.19045',
        run,
      });
      const report = await detectCpuFeatures(deps);
      assert.deepEqual(report.features, unknownFeatures());
      assert.equal(report.source, 'unavailable');
      assert.ok(report.note);
      assert.deepEqual(calls.cacheWrites, []);
      assert.deepEqual(toAdvisory(report, 'win32').missing, []);
    }
  });

  await test('Windows：有结果就按“CPU 型号 + 系统版本”缓存，命中时不再起 PowerShell', async () => {
    const first = makeDeps({
      platform: 'win32',
      osRelease: '10.0.19045',
      cpuModel: 'Old CPU',
      run: async () => '39=True\n40=False\n',
    });
    await detectCpuFeatures(first.deps);
    assert.equal(first.calls.cacheWrites.length, 1);
    const entry = first.calls.cacheWrites[0];
    assert.equal(entry.key, 'Old CPU|10.0.19045');

    const hit = makeDeps(
      {
        platform: 'win32',
        osRelease: '10.0.19045',
        cpuModel: 'Old CPU',
        run: async () => {
          throw new Error('must not run');
        },
      },
      { cache: entry },
    );
    const report = await detectCpuFeatures(hit.deps);
    assert.equal(report.fromCache, true);
    assert.equal(report.features.avx2, false);
    assert.deepEqual(hit.calls.cacheWrites, []);
  });

  await test('Windows：换 CPU 或升级系统后缓存作废，重新探测', async () => {
    const entry: CpuFeatureCacheEntry = {
      key: 'Old CPU|10.0.19045',
      features: { ...unknownFeatures(), avx: true, avx2: false },
      detectedAt: 1,
    };
    for (const change of [
      { cpuModel: 'New CPU', osRelease: '10.0.19045' },
      { cpuModel: 'Old CPU', osRelease: '10.0.22631' },
    ]) {
      const { deps, calls } = makeDeps(
        {
          platform: 'win32',
          ...change,
          run: async () => '39=True\n40=True\n',
        },
        { cache: entry },
      );
      const report = await detectCpuFeatures(deps);
      assert.equal(report.features.avx2, true, JSON.stringify(change));
      assert.equal(report.fromCache, undefined);
      assert.equal(calls.cacheWrites.length, 1);
    }
  });

  await test('Windows：缓存读取抛错也只是当没有缓存', async () => {
    const { deps } = makeDeps({
      platform: 'win32',
      osRelease: '10.0.19045',
      run: async () => '39=True\n40=True\n',
      cache: {
        read: () => {
          throw new Error('EPERM');
        },
        write: () => {
          throw new Error('EPERM');
        },
      },
    });
    const report = await detectCpuFeatures(deps);
    assert.equal(report.features.avx2, true);
  });

  await test('探测命令：明文 -Command、绝对路径、不用 -EncodedCommand', () => {
    const { file, args } = buildWindowsProbeCommand('D:\\Win');
    assert.equal(
      file,
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    assert.ok(args.includes('-NoProfile'));
    assert.ok(args.includes('-NonInteractive'));
    assert.ok(!args.some((a) => /^-e(nc|ncodedcommand)?$/i.test(a)));
    const script = args[args.indexOf('-Command') + 1];
    assert.match(script, /IsProcessorFeaturePresent/);
    assert.match(script, /39,40/);
    assert.equal(
      buildWindowsProbeCommand().file.startsWith('C:\\Windows'),
      true,
    );
  });

  await test('parseWindowsProbeOutput：只认 数字=True/False 的行', () => {
    assert.deepEqual(
      parseWindowsProbeOutput('x\r\n39=True\r\n 40=false \r\n41=maybe\r\n'),
      { 39: true, 40: false },
    );
    assert.deepEqual(parseWindowsProbeOutput(null), {});
  });

  await test('windowsBuildOf：取 os.release() 的第三段，旧系统与乱码返回 null', () => {
    assert.equal(windowsBuildOf('10.0.19045'), 19045);
    assert.equal(windowsBuildOf('10.0.22631'), 22631);
    assert.equal(windowsBuildOf('6.1.7601'), null);
    assert.equal(windowsBuildOf('10.0'), null);
    assert.equal(windowsBuildOf(''), null);
  });

  await test('缓存文件内容：格式不对一律当没有缓存，不抛错', () => {
    const good = JSON.stringify({
      key: 'k',
      detectedAt: 5,
      features: { avx: true, avx2: false },
    });
    assert.deepEqual(parseCpuCache(good), {
      key: 'k',
      detectedAt: 5,
      features: { avx: true, avx2: false, fma: null, f16c: null, bmi2: null },
    });
    for (const bad of [
      '',
      'not json',
      '{}',
      JSON.stringify({ key: 'k', detectedAt: 5, features: { avx2: 'yes' } }),
      JSON.stringify({ key: 1, detectedAt: 5 }),
    ]) {
      assert.equal(parseCpuCache(bad), null, bad);
    }
  });

  await test('未知平台：unknown 并带说明', async () => {
    const { deps } = makeDeps({ platform: 'freebsd' as NodeJS.Platform });
    const report = await detectCpuFeatures(deps);
    assert.equal(report.source, 'unavailable');
    assert.deepEqual(report.features, unknownFeatures());
  });

  finish('cpu-features');
}

void main();
