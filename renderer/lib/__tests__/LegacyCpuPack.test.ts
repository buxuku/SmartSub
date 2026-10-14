import { LEGACY_CPU_PACK_URL, canUseLegacyCpuPack } from '../legacyCpuPack';
import type { CpuAdvisory } from '../../../types/cpuAdvisory';

function advisory(overrides: Partial<CpuAdvisory> = {}): CpuAdvisory {
  return {
    applicable: true,
    translated: false,
    platform: 'linux',
    missing: [],
    unknown: [],
    source: 'proc-cpuinfo',
    cpuModel: 'Test CPU',
    ...overrides,
  };
}

test('the link is the legacy-cpu release page of the whisper.cpp fork', () => {
  expect(LEGACY_CPU_PACK_URL).toBe(
    'https://github.com/buxuku/whisper.cpp/releases/tag/legacy-cpu',
  );
});

test('AVX present but AVX2 missing on Windows or Linux (Sandy / Ivy Bridge, Bulldozer) can use the pack', () => {
  for (const platform of ['win32', 'linux']) {
    // Windows 只能探测 AVX / AVX2，Linux 能探测全部五项
    expect(canUseLegacyCpuPack(advisory({ platform, missing: ['avx2'] }))).toBe(
      true,
    );
    expect(
      canUseLegacyCpuPack(
        advisory({ platform, missing: ['avx2', 'fma', 'f16c', 'bmi2'] }),
      ),
    ).toBe(true);
  }
});

test('a CPU without AVX cannot run the pack either: its baseline is SSE4.2 + AVX', () => {
  expect(
    canUseLegacyCpuPack(
      advisory({
        platform: 'linux',
        missing: ['avx', 'avx2', 'fma', 'f16c', 'bmi2'],
      }),
    ),
  ).toBe(false);
  expect(
    canUseLegacyCpuPack(
      advisory({ platform: 'win32', missing: ['avx', 'avx2'] }),
    ),
  ).toBe(false);
});

test('nothing definitely missing means nothing to recommend, even if some features are unknown', () => {
  expect(canUseLegacyCpuPack(advisory())).toBe(false);
  expect(
    canUseLegacyCpuPack(
      advisory({ platform: 'win32', unknown: ['avx2', 'fma', 'f16c', 'bmi2'] }),
    ),
  ).toBe(false);
});

test('there is no pack for macOS, ARM or translated processes', () => {
  expect(
    canUseLegacyCpuPack(advisory({ platform: 'darwin', missing: ['avx2'] })),
  ).toBe(false);
  expect(
    canUseLegacyCpuPack(
      advisory({ applicable: false, source: 'not-applicable' }),
    ),
  ).toBe(false);
  // toAdvisory 在转译环境下本就不会给出 missing；即使给了，也不能推荐
  expect(
    canUseLegacyCpuPack(
      advisory({
        platform: 'win32',
        translated: true,
        source: 'translated',
        missing: ['avx2'],
      }),
    ),
  ).toBe(false);
});

test('a platform the probe knows nothing about gets no recommendation', () => {
  expect(
    canUseLegacyCpuPack(advisory({ platform: 'freebsd', missing: ['avx2'] })),
  ).toBe(false);
});
