/**
 * addonLoader 的候选顺序，以及「仅 CPU」在有自定义加速包时的含义。
 *
 * - 用户指定的自定义加速包在 Windows / Linux 的所有加速模式下都最先加载（macOS 本来就不受 gpuMode 影响）。
 *   「仅 CPU」的候选链是 自定义包 → 内置 CPU，内置 CPU 留作兜底：自定义文件加载失败时不至于没得用。
 * - 「仅 CPU」的承诺是“彻底关闭 GPU 加速”，而自定义包可能是 GPU 版：所以 Windows / Linux 上每次原生调用
 *   都会被压成 use_gpu=false；其余模式、macOS 一律原样透传。
 *
 * addonLoader 依赖 electron（经 storeManager / utils / addonManager），沿用 test-cuda-wiring.ts 的办法：
 * 拦截 require，把这几个依赖换成桩；候选筛选（addonSuppression）与熔断键（breaker）是纯逻辑，照常运行。
 * process.dlopen 也换成了桩，不会真的去加载原生模块；平台由桩伪装，因此这个测试在任何系统上都能跑。
 */
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { GpuMode } from '../../types/addon';
import { assert, finish, test } from './testkit';

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | null,
  isMain: boolean,
) => unknown;
const moduleInternals = Module as unknown as { _load: Loader };
const originalLoad = moduleInternals._load;
const originalDlopen = process.dlopen;

type Platform = 'win32' | 'linux' | 'darwin';
interface NativeCall {
  file: string;
  params: Record<string, unknown>;
}

// —— 磁盘上的假文件：tryLoadCandidate 会先确认文件存在 ——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-candidates-'));
const builtinCpu = path.join(root, 'addons', 'addon.node');
const builtinVulkan = path.join(root, 'addons', 'addon.vulkan.node');
const builtinCoreml = path.join(root, 'addons', 'addon.coreml.node');
const customAddon = path.join(root, 'custom', 'addon-linux-x64-avx.node');
for (const file of [builtinCpu, builtinVulkan, builtinCoreml, customAddon]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

// —— 桩的状态：每个用例开始前重置 ——
let platform: Platform = 'win32';
let appleSilicon = false;
let customPath: string | null = null;
let failLoad = new Set<string>();
let nativeCalls: NativeCall[] = [];
const storeData = new Map<string, unknown>();

moduleInternals._load = function (request, parent, isMain) {
  // 只替换 addonLoader 自己的依赖，别的模块要同名的相对路径时不受影响
  if (parent?.filename && /[\\/]addonLoader\.[tj]s$/.test(parent.filename)) {
    if (request === './storeManager') {
      return {
        store: {
          get: (key: string) => storeData.get(key),
          set: (key: string, value: unknown) => {
            storeData.set(key, value);
          },
        },
        logMessage: () => {},
      };
    }
    if (request === './utils') {
      return {
        getExtraResourcesPath: () => root,
        isAppleSilicon: () => appleSilicon,
      };
    }
    if (request === './cudaUtils') {
      return {
        getEffectivePlatform: () => platform,
        getGpuEnvironment: async () => ({
          platform,
          gpus: [],
          nvidia: null,
          vulkanRuntime: false,
        }),
        getBuiltinVulkanAddonPath: () => builtinVulkan,
      };
    }
    if (request === './addonManager') {
      return {
        getSelectedAddonVersion: () => null,
        isAddonInstalled: () => false,
        getAddonVersionDir: (version: string) =>
          path.join(root, 'userData', version),
        hasDependentLibs: () => false,
        getCustomAddonPath: () => customPath,
      };
    }
    if (request === './crash/nativeGuard') {
      return {
        beginNativeCall: () => () => {},
        isBreakerDisabledByEnv: () => true,
        lookupSuppression: () => null,
        recordNativeSuccess: () => {},
      };
    }
    if (request === './crash/cudaCompat') {
      return {
        partitionByCudaCompat: (candidates: unknown[]) => ({
          kept: candidates,
          incompatible: [],
        }),
      };
    }
    if (request === './engines/whisperAudioInput') {
      return { withNativeSafeAudioInput: (fn: unknown) => fn };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const addonLoader =
  require('../../main/helpers/addonLoader') as typeof import('../../main/helpers/addonLoader');

// 模块都加载完了再换 dlopen：别让它拦到加载依赖时的原生模块
process.dlopen = ((
  module: { exports: Record<string, unknown> },
  filename: string,
) => {
  if (failLoad.has(filename)) throw new Error(`dlopen failed: ${filename}`);
  module.exports.whisper = (
    params: Record<string, unknown>,
    callback: (error: Error | null, result?: unknown) => void,
  ) => {
    nativeCalls.push({ file: filename, params });
    callback(null, { ok: true });
  };
}) as typeof process.dlopen;

function resetWorld() {
  platform = 'win32';
  appleSilicon = false;
  customPath = null;
  failLoad = new Set();
  nativeCalls = [];
  storeData.clear();
  addonLoader.clearAddonLoadCache();
}

const ctx = (gpuMode: GpuMode, coremlEligible = false) => ({
  gpuMode,
  coremlEligible,
});
const describeChain = (
  candidates: Array<{ backend: string; source: string }>,
) => candidates.map((c) => `${c.backend}(${c.source})`);
const DESKTOP: Platform[] = ['win32', 'linux'];

async function main() {
  // —— 候选顺序 ——

  await test('Windows / Linux · 仅 CPU 没有自定义包：只有内置 CPU 包', async () => {
    for (const p of DESKTOP) {
      resetWorld();
      platform = p;
      const chain = await addonLoader.resolveCandidates(ctx('cpu-only'));
      assert.deepEqual(describeChain(chain), ['cpu(builtin)'], p);
    }
  });

  await test('Windows / Linux · 仅 CPU 设置了自定义包：自定义包最先加载，内置 CPU 兜底', async () => {
    for (const p of DESKTOP) {
      resetWorld();
      platform = p;
      customPath = customAddon;
      const chain = await addonLoader.resolveCandidates(ctx('cpu-only'));
      assert.deepEqual(
        describeChain(chain),
        ['custom(custom)', 'cpu(builtin)'],
        p,
      );
      assert.equal(chain[0].path, customAddon);
      assert.equal(chain[1].path, builtinCpu);
    }
  });

  await test('Windows / Linux · 自动与仅 GPU：自定义包照旧排第一，仅 GPU 仍没有内置 CPU', async () => {
    for (const p of DESKTOP) {
      resetWorld();
      platform = p;
      customPath = customAddon;
      assert.deepEqual(
        describeChain(await addonLoader.resolveCandidates(ctx('auto'))),
        ['custom(custom)', 'vulkan(builtin)', 'cpu(builtin)'],
        `auto / ${p}`,
      );
      assert.deepEqual(
        describeChain(await addonLoader.resolveCandidates(ctx('gpu-only'))),
        ['custom(custom)', 'vulkan(builtin)'],
        `gpu-only / ${p}`,
      );
    }
  });

  await test('macOS · 自定义包排第一，三种加速模式的候选链完全一致', async () => {
    const modes: GpuMode[] = ['auto', 'gpu-only', 'cpu-only'];
    for (const mode of modes) {
      resetWorld();
      platform = 'darwin';
      appleSilicon = true;
      customPath = customAddon;
      assert.deepEqual(
        describeChain(await addonLoader.resolveCandidates(ctx(mode, true))),
        ['custom(custom)', 'coreml(builtin)', 'metal(builtin)'],
        mode,
      );
    }
  });

  // —— 经由 loadBestAddon：实际加载哪个包、转写时传给它什么 ——

  await test('仅 CPU + 自定义包：加载的是自定义包，每次转写都以 use_gpu=false 调用，且不改写调用方的参数', async () => {
    resetWorld();
    customPath = customAddon;
    const result = await addonLoader.loadBestAddon(ctx('cpu-only'));

    assert.equal(result.backend, 'custom');
    assert.equal(result.path, customAddon);
    assert.equal(result.fallback, false);

    const params = { model: 'ggml-base.bin', language: 'en', use_gpu: true };
    await result.whisperAsync(params);

    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0].file, customAddon);
    assert.equal(
      nativeCalls[0].params.use_gpu,
      false,
      '“仅 CPU”下 GPU 版自定义包也不应使用 GPU',
    );
    assert.equal(nativeCalls[0].params.language, 'en', '其余参数原样透传');
    assert.equal(nativeCalls[0].params.model, 'ggml-base.bin');
    assert.equal(params.use_gpu, true, '调用方的参数对象不应被改写');
  });

  await test('仅 CPU + 自定义包加载失败：降级到内置 CPU，并记下失败原因', async () => {
    resetWorld();
    customPath = customAddon;
    failLoad.add(customAddon);
    const result = await addonLoader.loadBestAddon(ctx('cpu-only'));

    assert.equal(result.backend, 'cpu');
    assert.equal(result.path, builtinCpu);
    assert.equal(result.fallback, true);
    assert.equal(result.failedAttempts[0]?.backend, 'custom');
    assert.match(result.failedAttempts[0]?.error ?? '', /dlopen failed/);
  });

  await test('仅 CPU 没有自定义包：照常加载内置 CPU 包', async () => {
    resetWorld();
    const result = await addonLoader.loadBestAddon(ctx('cpu-only'));

    assert.equal(result.backend, 'cpu');
    assert.equal(result.path, builtinCpu);
    assert.equal(result.fallback, false);
  });

  await test('自动 + 自定义包：use_gpu 原样透传，只有“仅 CPU”才会被压成 false', async () => {
    resetWorld();
    customPath = customAddon;
    const result = await addonLoader.loadBestAddon(ctx('auto'));

    assert.equal(result.backend, 'custom');
    await result.whisperAsync({ use_gpu: true });
    assert.equal(nativeCalls[0].params.use_gpu, true);
  });

  await test('macOS 上残留的“仅 CPU”设置不影响 use_gpu（macOS 不受 gpuMode 影响）', async () => {
    resetWorld();
    platform = 'darwin';
    appleSilicon = true;
    customPath = customAddon;
    const result = await addonLoader.loadBestAddon(ctx('cpu-only', true));

    assert.equal(result.backend, 'custom');
    await result.whisperAsync({ use_gpu: true });
    assert.equal(nativeCalls[0].params.use_gpu, true);
  });

  moduleInternals._load = originalLoad;
  process.dlopen = originalDlopen;
  fs.rmSync(root, { recursive: true, force: true });
  finish('addonLoader 候选顺序与“仅 CPU”');
}

void main();
