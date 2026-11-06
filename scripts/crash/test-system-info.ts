import {
  parseProcCpuinfo,
  parseSysctlFeatureList,
} from '../../main/helpers/crash/cpuInfo';
import {
  gatherSystemInfo,
  type SystemInfoDeps,
} from '../../main/helpers/crash/systemInfo';
import { assert, finish, test } from './testkit';

// #493 同代的 Ivy Bridge：有 avx 与 f16c，没有 fma / avx2 / bmi2
const IVY_BRIDGE_CPUINFO = `processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
model\t\t: 58
model name\t: Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep sse sse2 ssse3 sse4_1 sse4_2 popcnt aes xsave avx f16c rdrand
bogomips\t: 6584.97

processor\t: 1
model name\t: Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz
flags\t\t: fpu vme
`;

const ARM_CPUINFO = `processor\t: 0
BogoMIPS\t: 50.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics
CPU implementer\t: 0x41
`;

function fakeDeps(overrides: Partial<SystemInfoDeps> = {}): SystemInfoDeps {
  return {
    platform: 'linux',
    arch: 'x64',
    release: '6.8.0',
    osVersion: '#1 SMP',
    osType: 'Linux',
    machine: 'x86_64',
    cpus: [{ model: 'Fake CPU' }, { model: 'Fake CPU' }],
    totalMem: 16 * 1024 * 1024 * 1024,
    freeMem: 4 * 1024 * 1024 * 1024,
    env: {},
    readFile: async () => null,
    sysctl: async () => null,
    ...overrides,
  };
}

async function main() {
  await test('/proc/cpuinfo：取第一个处理器块的型号与标志，flags 全是小写词', () => {
    const parsed = parseProcCpuinfo(IVY_BRIDGE_CPUINFO);
    assert.equal(parsed.model, 'Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz');
    assert.ok(parsed.flags.includes('avx'));
    assert.ok(parsed.flags.includes('f16c'));
    assert.ok(!parsed.flags.includes('avx2'));
    assert.ok(!parsed.flags.includes('fma'));
    // 第二个处理器块的 flags 不叠加（否则 vme 会出现两次）
    assert.equal(parsed.flags.filter((f) => f === 'vme').length, 1);
  });

  await test('/proc/cpuinfo：ARM 用 Features；空内容与无冒号的行不抛错', () => {
    assert.deepEqual(parseProcCpuinfo(ARM_CPUINFO).flags.slice(0, 3), [
      'fp',
      'asimd',
      'evtstrm',
    ]);
    assert.deepEqual(parseProcCpuinfo(''), { model: null, flags: [] });
    assert.deepEqual(parseProcCpuinfo('garbage line\nanother'), {
      model: null,
      flags: [],
    });
  });

  await test('sysctl 特性列表：按空白切分；空值得到空数组', () => {
    assert.deepEqual(parseSysctlFeatureList('FPU VME  AVX1.0\nF16C '), [
      'FPU',
      'VME',
      'AVX1.0',
      'F16C',
    ]);
    assert.deepEqual(parseSysctlFeatureList(null), []);
    assert.deepEqual(parseSysctlFeatureList(''), []);
  });

  await test('Linux：读 /proc/cpuinfo 的标志；读不到时记入 unavailable 而不是抛错', async () => {
    const ok = await gatherSystemInfo(
      fakeDeps({ readFile: async () => IVY_BRIDGE_CPUINFO }),
    );
    assert.equal(ok.cpu.model, 'Fake CPU');
    assert.equal(ok.cpu.logicalCores, 2);
    assert.ok(ok.cpu.flags?.includes('avx'));
    assert.deepEqual(ok.unavailable, []);
    assert.equal(ok.memory.totalMB, 16384);
    assert.equal(ok.memory.freeMB, 4096);

    const missing = await gatherSystemInfo(fakeDeps());
    assert.equal(missing.cpu.flags, undefined);
    assert.deepEqual(missing.unavailable, ['cpu.flags']);

    const throwing = await gatherSystemInfo(
      fakeDeps({
        readFile: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    assert.deepEqual(throwing.unavailable, ['cpu.flags']);
  });

  await test('Linux：os.cpus() 没给型号时用 /proc/cpuinfo 补上', async () => {
    const info = await gatherSystemInfo(
      fakeDeps({ cpus: [], readFile: async () => IVY_BRIDGE_CPUINFO }),
    );
    assert.equal(info.cpu.model, 'Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz');
    assert.equal(info.cpu.logicalCores, 0);
  });

  await test('macOS：Intel 取 sysctl 特性与 Rosetta 标志；Apple Silicon 没有特性列表是正常的', async () => {
    const values: Record<string, string> = {
      'machdep.cpu.brand_string': 'Intel(R) Core(TM) i7-4770HQ',
      'machdep.cpu.features': 'FPU VME SSE4.2 AVX1.0 F16C',
      'machdep.cpu.leaf7_features': 'BMI1 AVX2 BMI2',
      'sysctl.proc_translated': '0',
      'hw.model': 'MacBookPro11,3',
    };
    const intel = await gatherSystemInfo(
      fakeDeps({
        platform: 'darwin',
        cpus: [],
        sysctl: async (key) => values[key] ?? null,
      }),
    );
    assert.equal(intel.cpu.model, 'Intel(R) Core(TM) i7-4770HQ');
    assert.ok(intel.cpu.macFeatures?.includes('AVX1.0'));
    assert.deepEqual(intel.cpu.macLeaf7Features, ['BMI1', 'AVX2', 'BMI2']);
    assert.equal(intel.cpu.macExtFeatures, undefined);
    assert.equal(intel.cpu.translatedByRosetta, false);
    assert.equal(intel.cpu.macModel, 'MacBookPro11,3');

    const translated = await gatherSystemInfo(
      fakeDeps({
        platform: 'darwin',
        sysctl: async (key) => (key === 'sysctl.proc_translated' ? '1' : null),
      }),
    );
    assert.equal(translated.cpu.translatedByRosetta, true);

    const arm = await gatherSystemInfo(
      fakeDeps({
        platform: 'darwin',
        arch: 'arm64',
        cpus: [{ model: 'Apple M2' }],
        sysctl: async () => {
          throw new Error('no such key');
        },
      }),
    );
    assert.equal(arm.cpu.model, 'Apple M2');
    assert.equal(arm.cpu.macFeatures, undefined);
    assert.equal(arm.cpu.translatedByRosetta, null);
  });

  await test('环境变量只取白名单，凭据类变量永不出现；打包形态按环境变量判断', async () => {
    const info = await gatherSystemInfo(
      fakeDeps({
        platform: 'win32',
        env: {
          PROCESSOR_IDENTIFIER:
            'Intel64 Family 6 Model 58 Stepping 9, GenuineIntel',
          NUMBER_OF_PROCESSORS: '8',
          OPENAI_API_KEY: 'sk-secret',
          AWS_SECRET_ACCESS_KEY: 'zzz',
          USERNAME: 'alice',
          APPIMAGE: '/home/alice/SmartSub.AppImage',
        },
      }),
    );
    assert.deepEqual(Object.keys(info.env).sort(), [
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_IDENTIFIER',
    ]);
    const text = JSON.stringify(info);
    for (const leaked of ['sk-secret', 'zzz', 'alice']) {
      assert.ok(!text.includes(leaked), `不应出现 ${leaked}`);
    }
    // 只给出形态，不带 AppImage 的路径
    assert.equal(info.os.packaging, 'appimage');

    assert.equal(
      (await gatherSystemInfo(fakeDeps({ env: { FLATPAK_ID: 'x' } }))).os
        .packaging,
      'flatpak',
    );
    assert.equal(
      (await gatherSystemInfo(fakeDeps({ env: { SNAP: '/snap/x' } }))).os
        .packaging,
      'snap',
    );
    assert.equal((await gatherSystemInfo(fakeDeps())).os.packaging, 'none');
  });

  finish('systemInfo');
}

main();
