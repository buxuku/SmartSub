# FunASR 切换 sherpa-onnx Node 原生 addon 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐 Task 实施本计划（本仓库用户规则禁止子代理，不使用 subagent-driven-development）。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 FunASR 转写运行时从「Python sidecar 的 sherpa-onnx Python API」切换为「`sherpa-onnx-node` N-API 原生 addon」，根治 Windows 首次转写卡 0%，faster-whisper 的 Python 三层零回归。

**Architecture:** 方案 C——保留稳定边界（Adapter 契约 + `funasrModelCatalog`/`funasrModelDownloader`/`models/funasr/*` + 引擎感知 UI/i18n），新建一个隔离的原生运行时（`sherpaFunasrRuntime` 在 `worker_thread` 里用 `createAsync`/`decodeAsync` 跑 VAD+ASR），定点拆除 Python-FunASR 接线。原生库按需下载到 `userData`，由引擎仓 `smartsub-py-engine` 托管。

**Tech Stack:** Electron 30 + Next.js（nextron/webpack）；`sherpa-onnx-node` v1.13.x（N-API，CPU）；vendored 封装 JS + 自定义 `addon.js` 加载器（`process.dlopen` userData `.node`）；测试沿用 `scripts/test-engine-units.ts`（`npm run test:engines`，纯逻辑、自定义 `eq()`）。

> 关联设计：`docs/superpowers/specs/2026-06-17-funasr-sherpa-node-addon-design.md`

---

## 关键参考事实（实现前必读）

- 输入音频 `file.tempAudioFile` 已是 **16kHz / 单声道 / pcm_s16le WAV**（`main/helpers/audioProcessor.ts` 的 ffmpeg `.audioFrequency(16000).audioChannels(1)`），sherpa `readWave` 可直接读。
- `sherpa-onnx-node` 封装结构（来自官方源码 v1.13.2）：
  - `sherpa-onnx.js` 是入口，`require('./addon.js')` 取原生模块，并把 `OfflineRecognizer`(`./non-streaming-asr.js`)、`Vad`/`CircularBuffer`(`./vad.js`)、`readWave`(`addon.readWave`) 等组合导出。
  - `addon.js` 负责定位/加载原生 `.node`。**只有这一个文件**做原生加载，其余 wrapper 文件都 `require('./addon.js')` 后调用 `addon.<fn>`。
  - `OfflineRecognizer`：`new OfflineRecognizer(config)` / `static createAsync(config)`；`createStream()`；`decode(stream)` / `async decodeAsync(stream)`；`getResult(stream)`（返回解析后的 JSON：`{text, lang?, emotion?, event?, timestamps?, tokens?}`）。
  - `OfflineStream.acceptWaveform({samples: Float32Array, sampleRate})`。
  - `Vad`：`new Vad(config, bufferSizeInSeconds)`；`acceptWaveform(samples)`；`isEmpty()`；`isDetected()`；`front(enableExternalBuffer=true)`→`{start, samples}`；`pop()`；`flush()`；`clear()`；`reset()`。
- **Electron 必备**：所有返回缓冲区的调用传 `enableExternalBuffer = false`（Electron 21+ 否则报「External buffers are not allowed」）。本计划在 worker 内对 `vad.front(false)` 显式传 false；recognizer 结果走 JSON 不涉外部缓冲。
- 现有原生 addon 加载范式见 `main/helpers/addonLoader.ts`（`setupLibraryPath` 注入 `PATH`/`LD_LIBRARY_PATH` + `process.dlopen` + 会话缓存）。
- 下载/镜像/原子替换范式见 `main/helpers/pythonRuntime/downloader.ts`、`addonManager.ts`、`main/helpers/download/*`。
- 测试只覆盖**纯逻辑**（无 Electron / 无原生库 / 无模型）；原生端到端属手动冒烟。

---

## 文件结构（先锁定边界）

**新增（主仓）**
| 文件 | 职责 |
| --- | --- |
| `main/helpers/sherpaOnnx/sherpaConfig.ts` | 纯函数：`FunasrAddonParams`→sherpa `VadConfig`/`OfflineRecognizerConfig` 映射；段时间与进度数学。无 electron/fs 依赖（可单测） |
| `main/helpers/sherpaOnnx/sherpaLibPaths.ts` | userData 布局：`getSherpaLibDir/getSherpaLibStagingDir/...`、平台库文件名、`isSherpaLibInstalled`、manifest 读写 |
| `main/helpers/sherpaOnnx/sherpaLibManager.ts` | 安装态/卸载/备份/恢复/摘要（仿 `addonManager.ts`） |
| `main/helpers/sherpaOnnx/sherpaLibDownloader.ts` | 下载 6 平台库（镜像回退 + SHA256 + staging→current 原子替换 + 回滚 + mac ad-hoc 重签 + 加载自检） |
| `main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts` | 主侧编排：起常驻 worker、load/transcribe/cancel/dispose、会话缓存、进度回调 |
| `extraResources/sherpa/worker/sherpa-worker.js` | worker 入口：读 wav → VAD 分段 → 逐段 `decodeAsync` → 进度/结果 |
| `extraResources/sherpa/vendor/addon.js` | 自定义原生加载器（`process.dlopen` userData `.node`）覆盖官方同名文件 |
| `extraResources/sherpa/vendor/*.js` | 从 `node_modules/sherpa-onnx-node` 复制的官方封装（除 `addon.js`） |
| `types/sherpa.ts` | `RemoteSherpaLibManifest`/`SherpaLibStatus` 等类型 |

**修改（主仓）**
| 文件 | 改动 |
| --- | --- |
| `main/helpers/engines/funasrParams.ts` | `FunasrSidecarParams`→`FunasrAddonParams`（仅改名） |
| `main/helpers/engines/funasrEngine.ts` | 重写内核：`pythonRuntime`→`sherpaFunasrRuntime`；`isAvailable` 改查 sherpa 库；去 `pyEngineId` |
| `main/helpers/engines/types.ts` | `prewarm` 解耦说明（无签名变更） |
| `main/helpers/taskProcessor.ts` | prewarm 门控改为「有 `pyEngineId` 才 `ensureStarted`，总调 `adapter.prewarm?.()`」 |
| `main/helpers/ipcEngineHandlers.ts` | 删 funasr 的 PyEngine 接线；`set-transcription-engine` 改查 sherpa 库；新增 sherpa 库下载/卸载 IPC |
| `main/helpers/pythonRuntime/index.ts` | 删 `resolveEngineEnv('funasr')` 分支 |
| `main/helpers/pythonRuntime/autoUpdateCheck.ts` | `UPDATABLE_ENGINES` 去 `'funasr'` |
| `main/helpers/systemInfoManager.ts` | `funasrEngineInstalled` 来源改 sherpa 库 |
| `types/engine.ts` | `PyEngineId` 去 `'funasr'`（`TranscriptionEngine` 仍含 `funasr`） |
| `electron-builder.yml` | mac/win/linux `extraResources` 增 `./extraResources/sherpa/` |
| `scripts/test-engine-units.ts` | 追加 sherpaConfig 纯逻辑测试 |

**引擎仓 `smartsub-py-engine`（跨仓，PC 阶段）**
| 文件 | 改动 |
| --- | --- |
| `engines/funasr_sensevoice_engine.py`、`requirements-funasr.txt`、`engines/__init__.py`、`release.yml`、`smoke_test.py` | 删除 funasr 引擎；新增「sherpa 原生库重打包」CI 产物 |

---

# Phase PA — 原生库下载 + 加载打通

> 目标：sherpa 库下载到 userData → worker 能 `require` 封装并对一段 wav `decode` 出文本（最小 hello-decode）。

## Task PA-1: 引擎仓——sherpa 原生库重打包 CI（先出开发平台）

**Files:**

- Create（引擎仓）: `.github/workflows/sherpa-libs.yml`
- Create（引擎仓）: `scripts/pack_sherpa_libs.mjs`

- [ ] **Step 1: 写重打包脚本 `scripts/pack_sherpa_libs.mjs`**

```js
// 用法: node scripts/pack_sherpa_libs.mjs <platformKey> <sherpaVersion> <outDir>
// platformKey ∈ darwin-arm64 | darwin-x64 | win-x64 | win-ia32 | linux-x64 | linux-arm64
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  createReadStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [platformKey, version, outDir] = process.argv.slice(2);
if (!platformKey || !version || !outDir) {
  throw new Error(
    'usage: pack_sherpa_libs.mjs <platformKey> <version> <outDir>',
  );
}
const pkg = `sherpa-onnx-${platformKey}@${version}`;
const work = path.join(outDir, '.work', platformKey);
mkdirSync(work, { recursive: true });
// 1) 用 npm pack 取平台包 tarball（无需安装、无需编译器）
execSync(`npm pack ${pkg}`, { cwd: work, stdio: 'inherit' });
const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
execSync(`tar -xzf ${tgz}`, { cwd: work, stdio: 'inherit' });
const pkgDir = path.join(work, 'package');
// 2) 收集运行所需文件：sherpa-onnx.node + 所有原生库
const wanted = readdirSync(pkgDir).filter(
  (f) => f === 'sherpa-onnx.node' || /\.(dylib|so(\.\d+)*|dll)$/.test(f),
);
if (!wanted.includes('sherpa-onnx.node')) {
  throw new Error(`sherpa-onnx.node not found in ${pkgDir}`);
}
const stage = path.join(outDir, `smartsub-sherpa-onnx-${platformKey}`);
mkdirSync(stage, { recursive: true });
for (const f of wanted) copyFileSync(path.join(pkgDir, f), path.join(stage, f));
writeFileSync(
  path.join(stage, 'manifest.json'),
  JSON.stringify(
    {
      platform: platformKey,
      sherpaVersion: version,
      files: wanted,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
// 3) 打 tar.gz + sha256
const asset = path.join(
  outDir,
  `smartsub-sherpa-onnx-${platformKey}-${version}.tar.gz`,
);
execSync(`tar -czf ${asset} -C ${stage} .`, { stdio: 'inherit' });
const hash = createHash('sha256');
await new Promise((res, rej) =>
  createReadStream(asset)
    .on('data', (d) => hash.update(d))
    .on('end', res)
    .on('error', rej),
);
writeFileSync(
  `${asset}.sha256`,
  `${hash.digest('hex')}  ${path.basename(asset)}\n`,
);
console.log('packed', asset);
```

- [ ] **Step 2: 写 workflow `.github/workflows/sherpa-libs.yml`**

```yaml
name: sherpa-libs
on:
  workflow_dispatch:
    inputs:
      sherpaVersion:
        {
          description: 'sherpa-onnx-node version',
          required: true,
          default: '1.13.2',
        }
jobs:
  pack:
    strategy:
      matrix:
        platformKey:
          [darwin-arm64, darwin-x64, win-x64, win-ia32, linux-x64, linux-arm64]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node scripts/pack_sherpa_libs.mjs ${{ matrix.platformKey }} ${{ inputs.sherpaVersion }} ./out
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: sherpa-libs-latest
          files: |
            ./out/smartsub-sherpa-onnx-${{ matrix.platformKey }}-${{ inputs.sherpaVersion }}.tar.gz
            ./out/smartsub-sherpa-onnx-${{ matrix.platformKey }}-${{ inputs.sherpaVersion }}.tar.gz.sha256
```

- [ ] **Step 3: 本地先出 1 个开发平台产物（不依赖 CI，便于联调）**

Run（开发机，引擎仓）：`node scripts/pack_sherpa_libs.mjs darwin-arm64 1.13.2 ./out`
Expected: 生成 `./out/smartsub-sherpa-onnx-darwin-arm64-1.13.2.tar.gz` 与 `.sha256`，解出含 `sherpa-onnx.node` + `*.dylib` + `manifest.json`。

- [ ] **Step 4: Commit（引擎仓）**

```bash
git add scripts/pack_sherpa_libs.mjs .github/workflows/sherpa-libs.yml
git commit -m "ci(sherpa): repackage sherpa-onnx-node native libs as release assets"
```

## Task PA-2: 类型与 userData 布局

**Files:**

- Create: `types/sherpa.ts`
- Create: `main/helpers/sherpaOnnx/sherpaLibPaths.ts`

- [ ] **Step 1: 写 `types/sherpa.ts`**

```ts
export interface RemoteSherpaLibManifest {
  platform: string; // darwin-arm64 等
  sherpaVersion: string; // 1.13.2
  files: string[]; // [sherpa-onnx.node, *.dylib/.so/.dll]
  builtAt: string;
}

export interface SherpaLibStatus {
  installed: boolean;
  version?: string;
  platform?: string;
  installedAt?: string;
}
```

- [ ] **Step 2: 写 `main/helpers/sherpaOnnx/sherpaLibPaths.ts`**

```ts
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { RemoteSherpaLibManifest } from '../../../types/sherpa';

/** 当前平台 key，与引擎仓产物命名一致。 */
export function getSherpaPlatformKey(): string {
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch; // x64/arm64/ia32
  if (process.platform === 'win32')
    return `win-${arch === 'arm64' ? 'x64' : arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

export function getSherpaRootDir(): string {
  const root = path.join(app.getPath('userData'), 'sherpa-onnx');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getSherpaLibDir(): string {
  return path.join(getSherpaRootDir(), 'current');
}
export function getSherpaStagingDir(): string {
  return path.join(getSherpaRootDir(), 'staging');
}
export function getSherpaPreviousDir(): string {
  return path.join(getSherpaRootDir(), 'previous');
}
export function getSherpaNativePath(): string {
  return path.join(getSherpaLibDir(), 'sherpa-onnx.node');
}
export function getSherpaManifestPath(): string {
  return path.join(getSherpaLibDir(), 'manifest.json');
}

export function isSherpaLibInstalled(): boolean {
  return fs.existsSync(getSherpaNativePath());
}

export function readSherpaManifest(): RemoteSherpaLibManifest | null {
  try {
    const p = getSherpaManifestPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（无新错误）。

- [ ] **Step 4: Commit**

```bash
git add types/sherpa.ts main/helpers/sherpaOnnx/sherpaLibPaths.ts
git commit -m "feat(sherpa): userData layout + types for native lib"
```

## Task PA-3: 纯配置映射（sherpaConfig）+ 单测

**Files:**

- Modify: `main/helpers/engines/funasrParams.ts`（改名）
- Create: `main/helpers/sherpaOnnx/sherpaConfig.ts`
- Test: `scripts/test-engine-units.ts`（追加）

- [ ] **Step 1: 重命名 `FunasrSidecarParams` → `FunasrAddonParams`**

在 `main/helpers/engines/funasrParams.ts`：把 `export interface FunasrSidecarParams {` 改为 `export interface FunasrAddonParams {`，并把函数返回类型 `): FunasrSidecarParams {` 改为 `): FunasrAddonParams {`。字段不变。

- [ ] **Step 2: 写失败测试（追加到 `scripts/test-engine-units.ts` 末尾、`console.log` 汇总行之前）**

```ts
// --- sherpaConfig: VAD/recognizer 映射 + 段时间/进度 ---
import {
  buildVadConfig,
  buildRecognizerConfig,
  segmentTiming,
  progressPercent,
} from '../main/helpers/sherpaOnnx/sherpaConfig';

const P = {
  language: 'auto',
  use_itn: true,
  provider: 'cpu',
  num_threads: 2,
  vad_threshold: 0.5,
  vad_min_silence_duration_ms: 100,
  vad_min_speech_duration_ms: 250,
  vad_max_speech_duration_s: 0,
};
eq(
  buildVadConfig('/m/silero_vad.onnx', P).sileroVad,
  {
    model: '/m/silero_vad.onnx',
    threshold: 0.5,
    minSpeechDuration: 0.25,
    minSilenceDuration: 0.1,
    windowSize: 512,
    maxSpeechDuration: 100000,
  },
  'sherpa: vad config maps ms->s and 0->unlimited',
);
eq(
  buildRecognizerConfig('sense_voice', '/m/model.int8.onnx', '/m/tokens.txt', P)
    .modelConfig.senseVoice,
  { model: '/m/model.int8.onnx', language: '', useInverseTextNormalization: 1 },
  'sherpa: sensevoice config (auto->"", itn on)',
);
eq(
  buildRecognizerConfig('paraformer', '/m/model.int8.onnx', '/m/tokens.txt', P)
    .modelConfig.paraformer,
  { model: '/m/model.int8.onnx' },
  'sherpa: paraformer config',
);
eq(
  buildRecognizerConfig('paraformer', '/m/a.onnx', '/m/t.txt', P).modelConfig
    .senseVoice,
  undefined,
  'sherpa: paraformer has no senseVoice block',
);
eq(
  segmentTiming(16000, 8000),
  { start: 1, end: 1.5 },
  'sherpa: segment timing sec',
);
eq(progressPercent(50, 200), 25, 'sherpa: progress 25%');
eq(progressPercent(5, 0), 100, 'sherpa: progress total 0 -> 100');
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npm run test:engines`
Expected: 编译报错 `Cannot find module '../main/helpers/sherpaOnnx/sherpaConfig'`（模块未实现）。

- [ ] **Step 4: 写实现 `main/helpers/sherpaOnnx/sherpaConfig.ts`**

```ts
import type { FunasrAddonParams } from '../engines/funasrParams';

const SAMPLE_RATE = 16000;
const UNLIMITED_SPEECH_SECONDS = 100000;

export interface VadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
    maxSpeechDuration: number;
  };
  sampleRate: number;
  numThreads: number;
  debug: number;
}

export interface OfflineRecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: {
    senseVoice?: {
      model: string;
      language: string;
      useInverseTextNormalization: number;
    };
    paraformer?: { model: string };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: number;
  };
}

export function buildVadConfig(
  vadModel: string,
  p: FunasrAddonParams,
): VadConfig {
  return {
    sileroVad: {
      model: vadModel,
      threshold: p.vad_threshold,
      minSpeechDuration: p.vad_min_speech_duration_ms / 1000,
      minSilenceDuration: p.vad_min_silence_duration_ms / 1000,
      windowSize: 512,
      maxSpeechDuration:
        p.vad_max_speech_duration_s > 0
          ? p.vad_max_speech_duration_s
          : UNLIMITED_SPEECH_SECONDS,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  };
}

export function buildRecognizerConfig(
  modelType: 'sense_voice' | 'paraformer',
  asrModel: string,
  tokens: string,
  p: FunasrAddonParams,
): OfflineRecognizerConfig {
  const modelConfig: OfflineRecognizerConfig['modelConfig'] = {
    tokens,
    numThreads: p.num_threads,
    provider: p.provider,
    debug: 0,
  };
  if (modelType === 'paraformer') {
    modelConfig.paraformer = { model: asrModel };
  } else {
    modelConfig.senseVoice = {
      model: asrModel,
      language: p.language === 'auto' ? '' : p.language,
      useInverseTextNormalization: p.use_itn ? 1 : 0,
    };
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
  };
}

export interface SegmentTiming {
  start: number;
  end: number;
}
export function segmentTiming(
  startSample: number,
  numSamples: number,
  sampleRate = SAMPLE_RATE,
): SegmentTiming {
  return {
    start: startSample / sampleRate,
    end: (startSample + numSamples) / sampleRate,
  };
}

export function progressPercent(processed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm run test:engines`
Expected: `engine unit tests: N passed, 0 failed`（含新增 7 条）。

- [ ] **Step 6: Commit**

```bash
git add main/helpers/sherpaOnnx/sherpaConfig.ts main/helpers/engines/funasrParams.ts scripts/test-engine-units.ts
git commit -m "feat(sherpa): pure config mapping (vad/recognizer/timing) + tests"
```

## Task PA-4: vendored 封装 + 自定义加载器 + extraResources

**Files:**

- Create: `extraResources/sherpa/vendor/*`（复制官方封装 + 自定义 addon.js）
- Create: `extraResources/sherpa/README.md`（记录来源/版本）
- Modify: `electron-builder.yml`

- [ ] **Step 1: 取官方封装到 vendor 目录**

Run:

```bash
cd "$(mktemp -d)" && npm pack sherpa-onnx-node@1.13.2 && tar -xzf sherpa-onnx-node-*.tgz
mkdir -p "$OLDPWD/extraResources/sherpa/vendor"
cp package/*.js "$OLDPWD/extraResources/sherpa/vendor/"
cd "$OLDPWD" && ls extraResources/sherpa/vendor
```

Expected: vendor 下出现 `addon.js sherpa-onnx.js non-streaming-asr.js vad.js types.js streaming-asr.js ...` 等官方 JS。

- [ ] **Step 2: 用自定义加载器覆盖官方 `addon.js`**

把 `extraResources/sherpa/vendor/addon.js` 内容整体替换为：

```js
'use strict';
// 自定义加载器：从 userData 下载的目录 dlopen 原生库（覆盖官方按 npm 平台包解析的逻辑）。
// SHERPA_ONNX_LIB_DIR 由主进程在创建 worker 时通过 env 注入。
const path = require('path');

const libDir = process.env.SHERPA_ONNX_LIB_DIR;
if (!libDir) {
  throw new Error(
    'SHERPA_ONNX_LIB_DIR is not set; cannot locate sherpa-onnx native library',
  );
}
const nativePath = path.join(libDir, 'sherpa-onnx.node');
const mod = { exports: {} };
process.dlopen(mod, nativePath);
module.exports = mod.exports;
```

- [ ] **Step 3: 记录来源 `extraResources/sherpa/README.md`**

```md
# sherpa vendor

封装 JS 复制自 npm `sherpa-onnx-node@1.13.2`（Apache-2.0）。
`addon.js` 已替换为自定义加载器：从 `SHERPA_ONNX_LIB_DIR` dlopen `sherpa-onnx.node`。
原生库不在此处，按需下载到 userData/sherpa-onnx/current（见 sherpaLibDownloader）。
升级版本：重新 `npm pack` 覆盖除 addon.js 外的文件。
```

- [ ] **Step 4: electron-builder 打包 vendor + worker**

在 `electron-builder.yml` 的 `mac.extraResources`、`win.extraResources`、`linux.extraResources` 各追加（与现有 `addons` 同级）：

```yaml
- from: ./extraResources/sherpa/
  to: ./extraResources/sherpa/
  filter:
    - '**/*'
```

- [ ] **Step 5: Commit**

```bash
git add extraResources/sherpa electron-builder.yml
git commit -m "feat(sherpa): vendor sherpa-onnx-node wrapper + custom userData loader"
```

## Task PA-5: 库管理 + 下载器（最小可用）

**Files:**

- Create: `main/helpers/sherpaOnnx/sherpaLibManager.ts`
- Create: `main/helpers/sherpaOnnx/sherpaLibDownloader.ts`

- [ ] **Step 1: 写 `sherpaLibManager.ts`**

```ts
import fs from 'fs';
import { logMessage } from '../storeManager';
import {
  getSherpaLibDir,
  getSherpaStagingDir,
  getSherpaPreviousDir,
  isSherpaLibInstalled,
  readSherpaManifest,
} from './sherpaLibPaths';
import type { SherpaLibStatus } from '../../../types/sherpa';

export function getSherpaLibStatus(): SherpaLibStatus {
  const m = readSherpaManifest();
  return {
    installed: isSherpaLibInstalled(),
    version: m?.sherpaVersion,
    platform: m?.platform,
    installedAt: m?.builtAt,
  };
}

/** staging → current 原子替换；旧 current 备份到 previous。 */
export function promoteStagingToCurrent(): void {
  const current = getSherpaLibDir();
  const staging = getSherpaStagingDir();
  const previous = getSherpaPreviousDir();
  if (!fs.existsSync(staging)) throw new Error('sherpa staging dir missing');
  if (fs.existsSync(previous))
    fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(current)) fs.renameSync(current, previous);
  fs.renameSync(staging, current);
  logMessage('sherpa lib promoted staging->current', 'info');
}

export function rollbackToPrevious(): boolean {
  const current = getSherpaLibDir();
  const previous = getSherpaPreviousDir();
  if (!fs.existsSync(previous)) return false;
  if (fs.existsSync(current))
    fs.rmSync(current, { recursive: true, force: true });
  fs.renameSync(previous, current);
  logMessage('sherpa lib rolled back to previous', 'warning');
  return true;
}

export function removeSherpaLib(): void {
  for (const d of [
    getSherpaLibDir(),
    getSherpaStagingDir(),
    getSherpaPreviousDir(),
  ]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
  logMessage('sherpa lib removed', 'info');
}
```

- [ ] **Step 2: 写 `sherpaLibDownloader.ts`（复用现有镜像下载与 mac 重签）**

```ts
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import decompress from 'decompress';
import { logMessage } from '../storeManager';
import { MirrorDownloader } from '../download/mirrorDownloader';
import { resolveReleaseBaseUrl } from '../download/sources';
import { getSourceFallbackOrder } from '../downloadSourceOrder';
import { isDarwin } from '../utils';
import {
  getSherpaPlatformKey,
  getSherpaStagingDir,
  getSherpaRootDir,
} from './sherpaLibPaths';
import {
  promoteStagingToCurrent,
  rollbackToPrevious,
} from './sherpaLibManager';

const SHERPA_VERSION = '1.13.2';
const SHERPA_TAG = 'sherpa-libs-latest';
const SHERPA_REPO = {
  github: 'buxuku/smartsub-py-engine',
  gitcode: 'buxuku1/smartsub-py-engine',
};

function assetName(platformKey: string): string {
  return `smartsub-sherpa-onnx-${platformKey}-${SHERPA_VERSION}.tar.gz`;
}

/** macOS：改 install_name 为 @loader_path + ad-hoc 重签，规避 SIP 屏蔽 DYLD。 */
function resignMac(dir: string): void {
  if (!isDarwin()) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.node') || f.endsWith('.dylib'));
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const otool = execFileSync('otool', ['-L', full]).toString();
      for (const line of otool.split('\n')) {
        const m = line.trim().match(/^(@rpath\/(\S+))\s/);
        if (m) {
          execFileSync('install_name_tool', [
            '-change',
            m[1],
            `@loader_path/${m[2]}`,
            full,
          ]);
        }
      }
    } catch (e) {
      logMessage(`otool/install_name_tool skipped for ${f}: ${e}`, 'warning');
    }
  }
  for (const f of files) {
    try {
      execFileSync('codesign', ['-s', '-', '--force', path.join(dir, f)]);
    } catch (e) {
      logMessage(`codesign ad-hoc failed for ${f}: ${e}`, 'warning');
    }
  }
}

export async function downloadSherpaLib(
  preferredSource: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const platformKey = getSherpaPlatformKey();
  const staging = getSherpaStagingDir();
  if (fs.existsSync(staging))
    fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const tmp = path.join(getSherpaRootDir(), assetName(platformKey));
  const downloader = new MirrorDownloader((p) => onProgress(p.progress ?? 0));
  let lastErr: unknown;
  for (const source of getSourceFallbackOrder(preferredSource as any)) {
    try {
      const base = resolveReleaseBaseUrl(source, SHERPA_REPO, SHERPA_TAG);
      await downloader.download(`${base}/${assetName(platformKey)}`, tmp);
      // 解压到 staging（tar.gz 内即文件平铺）
      await decompress(tmp, staging);
      fs.rmSync(tmp, { force: true });
      resignMac(staging);
      // 加载自检：require 自定义 addon + readWave 存在
      assertLoadable(staging);
      promoteStagingToCurrent();
      logMessage(`sherpa lib installed from ${source}`, 'info');
      return;
    } catch (e) {
      lastErr = e;
      logMessage(`sherpa lib source ${source} failed: ${e}`, 'warning');
    }
  }
  rollbackToPrevious();
  throw new Error(`sherpa lib download failed: ${lastErr}`);
}

/** 在主进程用临时 env 加载 staging 的 .node 自检（不进 worker）。 */
function assertLoadable(dir: string): void {
  const prev = process.env.SHERPA_ONNX_LIB_DIR;
  process.env.SHERPA_ONNX_LIB_DIR = dir;
  try {
    const vendorDir = path.join(
      require('../utils').getExtraResourcesPath(),
      'sherpa',
      'vendor',
    );
    delete require.cache[require.resolve(path.join(vendorDir, 'addon.js'))];
    const addon = require(path.join(vendorDir, 'addon.js'));
    if (typeof addon.readWave !== 'function') {
      throw new Error('sherpa addon loaded but readWave missing');
    }
  } finally {
    process.env.SHERPA_ONNX_LIB_DIR = prev;
  }
}
```

> 注：`MirrorDownloader.download(url, dest)`、`resolveReleaseBaseUrl(source, repo, tag)`、`getSourceFallbackOrder(source)` 的签名以 `scripts/test-engine-units.ts` 中用法为准；若实际签名不同，按 `main/helpers/download/*` 现有调用点对齐（不改其逻辑）。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（如 `MirrorDownloader.download` 签名不符，按现有调用点修正参数，不改其实现）。

- [ ] **Step 4: Commit**

```bash
git add main/helpers/sherpaOnnx/sherpaLibManager.ts main/helpers/sherpaOnnx/sherpaLibDownloader.ts
git commit -m "feat(sherpa): native lib manager + mirror downloader with mac resign"
```

## Task PA-6: hello-decode 冒烟（手动，验证 PA 打通）

**Files:**

- Create（临时，验证后删）: `scripts/dev-sherpa-smoke.mjs`

- [ ] **Step 1: 准备库与模型**

手动把 PA-1 Step 3 的 `darwin-arm64` 产物解压到 `~/Library/Application Support/SmartSub/sherpa-onnx/current/`，并确保 `models/funasr/sensevoice-small/{model.int8.onnx,tokens.txt}` 与 `models/funasr/silero-vad/silero_vad.onnx` 已下载（资源中心或手动）。

- [ ] **Step 2: 写冒烟脚本 `scripts/dev-sherpa-smoke.mjs`**

```js
// 用 vendored 封装 + userData 库对一段 16k wav 做 VAD+ASR。
// 用法: SHERPA_ONNX_LIB_DIR=<current> node scripts/dev-sherpa-smoke.mjs <wav> <asrModelDir> <vadOnnx>
import path from 'node:path';
const [wav, asrDir, vad] = process.argv.slice(2);
const vendor = path.join(
  process.cwd(),
  'extraResources',
  'sherpa',
  'vendor',
  'sherpa-onnx.js',
);
const sherpa = require(vendor);
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: {
      model: path.join(asrDir, 'model.int8.onnx'),
      language: '',
      useInverseTextNormalization: 1,
    },
    tokens: path.join(asrDir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
});
const wave = sherpa.readWave(wav);
const stream = recognizer.createStream();
stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
recognizer.decode(stream);
console.log('TEXT:', recognizer.getResult(stream).text);
```

- [ ] **Step 3: 运行冒烟**

Run: `SHERPA_ONNX_LIB_DIR="$HOME/Library/Application Support/SmartSub/sherpa-onnx/current" node scripts/dev-sherpa-smoke.mjs /path/to/16k.wav "$HOME/Library/Application Support/SmartSub/models/funasr/sensevoice-small" "$HOME/Library/Application Support/SmartSub/models/funasr/silero-vad/silero_vad.onnx"`
Expected: 打印 `TEXT: <识别文本>`，无崩溃。

> 若 macOS 报 dylib 加载失败：确认已对 current 下 `.node/.dylib` 执行 `install_name_tool @loader_path` + `codesign -s -`（PA-5 的 resignMac 会自动处理；手动放置时需手动跑一次）。

- [ ] **Step 4: 删除临时脚本并提交**

```bash
git rm scripts/dev-sherpa-smoke.mjs 2>/dev/null || rm -f scripts/dev-sherpa-smoke.mjs
git commit -am "chore(sherpa): PA smoke verified (remove temp script)" || true
```

---

# Phase PB — worker 转写流水线 + 适配器接线

> 目标：端到端 SenseVoice/Paraformer 出 SRT；进度/取消/预热正常；Windows 首次转写不卡 0%。

## Task PB-1: worker 入口 sherpa-worker.js

**Files:**

- Create: `extraResources/sherpa/worker/sherpa-worker.js`

- [ ] **Step 1: 写 worker**

```js
'use strict';
const path = require('path');
const { parentPort } = require('worker_threads');

// vendor 目录与 worker 同在 extraResources/sherpa 下
const sherpa = require(path.join(__dirname, '..', 'vendor', 'sherpa-onnx.js'));

const SAMPLE_RATE = 16000;
let recognizer = null;
let vad = null;
let cacheKey = '';
const cancelled = new Set();

function buildKey(req) {
  return [
    req.modelType,
    req.asrModel,
    req.tokens,
    req.params.num_threads,
    req.params.language,
    req.params.use_itn,
  ].join('|');
}

function ensureLoaded(req) {
  const key = buildKey(req);
  if (recognizer && key === cacheKey) return;
  const { buildVadConfig, buildRecognizerConfig } = loadConfigHelpers();
  recognizer = new sherpa.OfflineRecognizer(
    buildRecognizerConfig(req.modelType, req.asrModel, req.tokens, req.params),
  );
  vad = new sherpa.Vad(buildVadConfig(req.vadModel, req.params), 60);
  cacheKey = key;
}

// 复制 sherpaConfig 的纯逻辑（worker 不经 webpack，直接内联，避免跨目录 require TS）
function loadConfigHelpers() {
  const UNLIMITED = 100000;
  const buildVadConfig = (vadModel, p) => ({
    sileroVad: {
      model: vadModel,
      threshold: p.vad_threshold,
      minSpeechDuration: p.vad_min_speech_duration_ms / 1000,
      minSilenceDuration: p.vad_min_silence_duration_ms / 1000,
      windowSize: 512,
      maxSpeechDuration:
        p.vad_max_speech_duration_s > 0
          ? p.vad_max_speech_duration_s
          : UNLIMITED,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  });
  const buildRecognizerConfig = (modelType, asrModel, tokens, p) => {
    const modelConfig = {
      tokens,
      numThreads: p.num_threads,
      provider: p.provider,
      debug: 0,
    };
    if (modelType === 'paraformer')
      modelConfig.paraformer = { model: asrModel };
    else
      modelConfig.senseVoice = {
        model: asrModel,
        language: p.language === 'auto' ? '' : p.language,
        useInverseTextNormalization: p.use_itn ? 1 : 0,
      };
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig,
    };
  };
  return { buildVadConfig, buildRecognizerConfig };
}

async function transcribe(req) {
  ensureLoaded(req);
  vad.reset();
  const wave = sherpa.readWave(req.audioFile); // {samples, sampleRate}
  const samples = wave.samples;
  const windowSize = 512;
  const total = samples.length;
  const segments = [];
  let lastPercent = -1;

  const drain = async () => {
    while (!vad.isEmpty()) {
      if (cancelled.has(req.id)) return;
      const seg = vad.front(false); // enableExternalBuffer=false (Electron)
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: seg.samples, sampleRate: SAMPLE_RATE });
      const r = await recognizer.decodeAsync(stream);
      const start = seg.start / SAMPLE_RATE;
      const end = (seg.start + seg.samples.length) / SAMPLE_RATE;
      const text = (r && r.text ? r.text : '').trim();
      if (text) segments.push({ start, end, text });
    }
  };

  for (let i = 0; i + windowSize < total; i += windowSize) {
    if (cancelled.has(req.id)) {
      cancelled.delete(req.id);
      return parentPort.postMessage({
        type: 'error',
        id: req.id,
        code: 'cancelled',
        message: 'cancelled',
      });
    }
    vad.acceptWaveform(samples.subarray(i, i + windowSize));
    await drain();
    const pct = total > 0 ? Math.min(99, Math.round((i / total) * 100)) : 99;
    if (pct !== lastPercent) {
      lastPercent = pct;
      parentPort.postMessage({ type: 'progress', id: req.id, percent: pct });
    }
  }
  vad.flush();
  await drain();
  if (cancelled.has(req.id)) {
    cancelled.delete(req.id);
    return parentPort.postMessage({
      type: 'error',
      id: req.id,
      code: 'cancelled',
      message: 'cancelled',
    });
  }
  parentPort.postMessage({ type: 'done', id: req.id, segments });
}

parentPort.on('message', (req) => {
  if (req.type === 'load') {
    try {
      ensureLoaded(req);
      parentPort.postMessage({ type: 'ready' });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: 'load', message: String(e) });
    }
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.id);
    return;
  }
  if (req.type === 'transcribe') {
    transcribe(req).catch((e) =>
      parentPort.postMessage({ type: 'error', id: req.id, message: String(e) }),
    );
    return;
  }
});
```

> 说明：worker 是 extraResources 里的纯 JS（不经 webpack），故内联配置逻辑而非 require TS 模块；与 `sherpaConfig.ts` 保持等价（PA-3 已对该逻辑单测，二者必须一致）。

- [ ] **Step 2: Commit**

```bash
git add extraResources/sherpa/worker/sherpa-worker.js
git commit -m "feat(sherpa): worker thread VAD+ASR pipeline"
```

## Task PB-2: 主侧运行时 sherpaFunasrRuntime.ts

**Files:**

- Create: `main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts`

- [ ] **Step 1: 写运行时**

```ts
import path from 'path';
import { Worker } from 'worker_threads';
import { logMessage } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';
import type { FunasrAddonParams } from '../engines/funasrParams';

export interface SherpaModelRequest {
  asrModel: string;
  tokens: string;
  vadModel: string;
  modelType: 'sense_voice' | 'paraformer';
  params: FunasrAddonParams;
}
export interface Segment {
  start: number;
  end: number;
  text: string;
}

function workerPath(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'worker',
    'sherpa-worker.js',
  );
}

class SherpaFunasrRuntime {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (s: { segments: Segment[] }) => void;
      reject: (e: Error) => void;
      onProgress?: (p: number) => void;
    }
  >();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    const w = new Worker(workerPath(), {
      env: {
        ...process.env,
        SHERPA_ONNX_LIB_DIR: getSherpaLibDir(),
        // Windows DLL / Linux SO 依赖解析（mac 靠 @loader_path）
        PATH: `${getSherpaLibDir()}${path.delimiter}${process.env.PATH ?? ''}`,
        LD_LIBRARY_PATH: `${getSherpaLibDir()}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
      },
    });
    w.on('message', (msg: any) => this.onMessage(msg));
    w.on('error', (e) => this.failAll(e));
    w.on('exit', (code) => {
      if (code !== 0) this.failAll(new Error(`sherpa worker exited ${code}`));
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private onMessage(msg: any): void {
    if (msg.type === 'ready') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') entry.onProgress?.(msg.percent);
    else if (msg.type === 'done') {
      this.pending.delete(msg.id);
      entry.resolve({ segments: msg.segments });
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      const err = new Error(msg.message) as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      entry.reject(err);
    }
  }

  private failAll(e: Error): void {
    for (const [, entry] of this.pending) entry.reject(e);
    this.pending.clear();
  }

  /** 预热：仅 load 模型，不转写。失败非致命。 */
  prewarm(model: SherpaModelRequest): void {
    try {
      this.ensureWorker().postMessage({ type: 'load', ...model });
    } catch (e) {
      logMessage(`sherpa prewarm skipped: ${e}`, 'warning');
    }
  }

  transcribe(
    model: SherpaModelRequest,
    audioFile: string,
    onProgress?: (p: number) => void,
  ): { id: string; result: Promise<{ segments: Segment[] }> } {
    const w = this.ensureWorker();
    const id = `t${++this.seq}`;
    const result = new Promise<{ segments: Segment[] }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    w.postMessage({ type: 'transcribe', id, audioFile, ...model });
    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

let runtime: SherpaFunasrRuntime | null = null;
export function getSherpaFunasrRuntime(): SherpaFunasrRuntime {
  if (!runtime) runtime = new SherpaFunasrRuntime();
  return runtime;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts
git commit -m "feat(sherpa): main-side runtime orchestrating worker (load/transcribe/cancel)"
```

## Task PB-3: 重写 funasrEngine 适配器内核

**Files:**

- Modify: `main/helpers/engines/funasrEngine.ts`

- [ ] **Step 1: 重写为基于 sherpaFunasrRuntime**

把 `main/helpers/engines/funasrEngine.ts` 整体替换为：

```ts
import fs from 'fs';
import path from 'path';
import type { EngineStatus } from '../../../types/engine';
import {
  getFunasrModelDir,
  isFunasrReady,
  getInstalledFunasrAsrModels,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaLibStatus } from '../sherpaOnnx/sherpaLibManager';
import {
  getSherpaFunasrRuntime,
  type SherpaModelRequest,
} from '../sherpaOnnx/sherpaFunasrRuntime';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { secondsToSrtTime } from './transcribeShared';
import { buildFunasrParams } from './funasrParams';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

let activeTranscribeId: string | null = null;

type FunasrAsrSelection = NonNullable<
  ReturnType<typeof resolveFunasrAsrSelection>
>;

function buildModelRequest(
  selection: FunasrAsrSelection,
  settings: Record<string, unknown>,
  sourceLanguage?: string,
): SherpaModelRequest {
  const asrDir = getFunasrModelDir(selection.id);
  return {
    asrModel: path.join(asrDir, 'model.int8.onnx'),
    tokens: path.join(asrDir, 'tokens.txt'),
    vadModel: path.join(getFunasrModelDir('silero-vad'), 'silero_vad.onnx'),
    modelType: selection.modelType,
    params: buildFunasrParams(settings, sourceLanguage),
  };
}

function prewarmFunasr(formData: Record<string, unknown>): void {
  try {
    if (!isSherpaLibInstalled() || !isFunasrReady()) return;
    const installedAsr = getInstalledFunasrAsrModels();
    const selection = resolveFunasrAsrSelection(
      (formData as { model?: string })?.model,
      installedAsr,
    );
    if (!selection) return;
    const settings = store.get('settings');
    const { sourceLanguage } = formData as { sourceLanguage?: string };
    getSherpaFunasrRuntime().prewarm(
      buildModelRequest(selection, settings, sourceLanguage),
    );
    logMessage('funasr (sherpa) prewarm started', 'info');
  } catch (error) {
    logMessage(`funasr prewarm error (non-fatal): ${error}`, 'warning');
  }
}

async function transcribeFunasr(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });
  const { tempAudioFile, srtFile } = file;
  const { sourceLanguage } = formData as { sourceLanguage?: string };
  const settings = store.get('settings');

  if (!isSherpaLibInstalled()) {
    throw new Error(
      'sherpa runtime not installed. Download it from Resource Hub > Engines.',
    );
  }
  if (!isFunasrReady()) {
    throw new Error(
      'funasr models not installed. Download SenseVoice/Paraformer + silero-VAD from Resource Hub > Models.',
    );
  }
  const installedAsr = getInstalledFunasrAsrModels();
  const selection = resolveFunasrAsrSelection(
    (formData as { model?: string })?.model,
    installedAsr,
  );
  if (!selection) {
    throw new Error('funasr ASR model not installed.');
  }

  const model = buildModelRequest(selection, settings, sourceLanguage);
  logMessage(
    `funasr(sherpa) model: ${JSON.stringify({ ...model, params: model.params })}`,
    'info',
  );
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const runtime = getSherpaFunasrRuntime();
  const { id, result } = runtime.transcribe(model, tempAudioFile, (percent) =>
    event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  );
  activeTranscribeId = id;

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeTranscribeId === id) runtime.cancel(id);
  };
  if (signal?.aborted) runtime.cancel(id);
  else signal?.addEventListener('abort', onAbort, { once: true });

  let transcription;
  try {
    transcription = await result;
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    activeTranscribeId = null;
  }
  if (signal?.aborted) throw new TaskCancelledError();

  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (s) =>
        [secondsToSrtTime(s.start), secondsToSrtTime(s.end), s.text || ''] as [
          string,
          string,
          string,
        ],
    ),
  );
  await fs.promises.writeFile(srtFile, formattedSrt);
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage('generate subtitle done (funasr/sherpa)', 'info');
  return srtFile;
}

export const funasrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'funasr',
  displayName: 'FunASR (SenseVoice / Paraformer)',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isSherpaLibInstalled()) {
      return {
        state: 'not_installed',
        message: 'sherpa runtime not downloaded',
      };
    }
    if (!isFunasrReady()) {
      return {
        state: 'not_installed',
        message: 'funasr models not downloaded',
      };
    }
    return { state: 'ready', version: getSherpaLibStatus().version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFunasr(ctx);
  },

  cancelActive(): void {
    if (activeTranscribeId) {
      getSherpaFunasrRuntime().cancel(activeTranscribeId);
      activeTranscribeId = null;
    }
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmFunasr(formData);
  },
};
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 可能报 `taskProcessor` 仍引用 funasr 的 `pyEngineId`（下个 Task 修）；funasrEngine 本身应通过。若报 `pyEngineId` 缺失于 adapter 类型——`pyEngineId` 是可选字段，去掉合法。

- [ ] **Step 3: Commit**

```bash
git add main/helpers/engines/funasrEngine.ts
git commit -m "feat(funasr): rewrite adapter kernel to use sherpa node runtime"
```

## Task PB-4: taskProcessor 预热门控解耦 Python

**Files:**

- Modify: `main/helpers/taskProcessor.ts:249-258`（prewarm 块）

- [ ] **Step 1: 改 prewarm 门控**

把 `taskProcessor.ts` 中现有预热块（约 249–258 行，`if (activeAdapter.requiresRuntime && activeAdapter.pyEngineId)`）改为：

```ts
const activeAdapter = getActiveEngineAdapter();
// Python 引擎需先 ensureStarted（启动 sidecar）；非 Python（如 sherpa funasr）跳过。
if (activeAdapter.requiresRuntime && activeAdapter.pyEngineId) {
  await getPythonRuntimeManager().ensureStarted(activeAdapter.pyEngineId);
}
// 所有支持预热的引擎统一预热（非致命）。
activeAdapter.prewarm?.(formData);
```

> 保留该块原有的 try/catch 包裹与日志；仅替换条件与调用结构。`getActiveEngineAdapter`、`getPythonRuntimeManager` 已在文件中导入。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add main/helpers/taskProcessor.ts
git commit -m "refactor(tasks): decouple prewarm gate from pyEngineId (sherpa funasr)"
```

## Task PB-5: 端到端冒烟（手动，PB 验收）

- [ ] **Step 1: 起开发环境**

Run: `npm run dev`
（已检查 terminals 文件夹无重复 dev 实例）

- [ ] **Step 2: 走查**

1. 资源中心切换当前引擎为 FunASR（PC 才做 UI 下载入口；此处用 PA 手动放置的库 + 已装模型）。
2. 选 SenseVoice，开始一个 >30s 视频任务 → 进度从 0 平滑上升、产出 SRT。
3. 选 Paraformer（中文）→ 产出 SRT。
4. 任务中途取消 → 立即停止、状态正确。
5. **Windows 机器**：冷启动 + 杀软开启，首个文件**不卡 0%**（核心验收）。

Expected: 全部满足；日志含 `funasr(sherpa)`。

- [ ] **Step 3: 无代码改动则不提交（仅记录验收）**

---

# Phase PC — 拆除 Python-FunASR + 引擎仓清理 + UI/IPC 收尾

> 目标：删干净 Python-FunASR 接线；提供 sherpa 库下载/卸载 UI/IPC；faster-whisper/whisper.cpp 全回归。

## Task PC-1: PyEngineId 去 funasr + pythonRuntime/autoUpdate 清理

**Files:**

- Modify: `types/engine.ts`（`PyEngineId`）
- Modify: `main/helpers/pythonRuntime/index.ts:4,23-39`
- Modify: `main/helpers/pythonRuntime/autoUpdateCheck.ts:13`

- [ ] **Step 1: `PyEngineId` 去 funasr**

在 `types/engine.ts` 把 `PyEngineId` 由 `'faster-whisper' | 'funasr'` 改为 `'faster-whisper'`（保留 `TranscriptionEngine` 的 `'funasr'`）。

- [ ] **Step 2: `pythonRuntime/index.ts` 删 funasr 分支**

删除 `import { getFunasrModelsRoot } from '../funasrModelCatalog';`（第 4 行）。把 `resolveEngineEnv` 改为只处理 faster-whisper：

```ts
function resolveEngineEnv(engineId: PyEngineId): Record<string, string> {
  const modelsPath = getFasterWhisperModelsPath();
  return {
    HF_HOME: modelsPath,
    HF_HUB_CACHE: path.join(modelsPath, 'hub'),
  };
}
```

- [ ] **Step 3: `autoUpdateCheck.ts` 去 funasr**

把 `const UPDATABLE_ENGINES: PyEngineId[] = ['faster-whisper', 'funasr'];` 改为 `const UPDATABLE_ENGINES: PyEngineId[] = ['faster-whisper'];`。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 报 `ipcEngineHandlers.ts` 仍把 `'funasr'` 当 PyEngineId（下个 Task 修）。

- [ ] **Step 5: Commit**

```bash
git add types/engine.ts main/helpers/pythonRuntime/index.ts main/helpers/pythonRuntime/autoUpdateCheck.ts
git commit -m "refactor(python): drop funasr from PyEngineId/runtime/auto-update"
```

## Task PC-2: ipcEngineHandlers 改接 + sherpa 库 IPC

**Files:**

- Modify: `main/helpers/ipcEngineHandlers.ts`

- [ ] **Step 1: 删 funasr 的 PyEngine 接线**

- `coerceEngineId`（约 29-31 行）：改为始终返回 `'faster-whisper'`：

```ts
function coerceEngineId(_value: unknown): PyEngineId {
  return 'faster-whisper';
}
```

- `setMainWindowForEngine`：删除 `getPyEngineDownloader('funasr', window);`（约 37 行）。
- `set-transcription-engine`：把 funasr 校验（约 62-64 行）改为查 sherpa 库：

```ts
if (engine === 'funasr' && !isSherpaLibInstalled()) {
  return { success: false, error: 'engine_not_installed' };
}
```

并在文件顶部加 `import { isSherpaLibInstalled } from './sherpaOnnx/sherpaLibPaths';`。

- warmup 分支（约 72-77 行）：funasr 不再走 python warmup，改为：

```ts
const warmupEngineId: PyEngineId | null =
  engine === 'fasterWhisper' ? 'faster-whisper' : null;
```

（funasr 的预热由 taskProcessor 在批次开始时统一触发，无需此处。）

- [ ] **Step 2: 新增 sherpa 库下载/卸载/状态 IPC（追加到本文件 handler 注册区）**

```ts
ipcMain.handle('sherpa-lib-status', async () => {
  const { getSherpaLibStatus } = await import('./sherpaOnnx/sherpaLibManager');
  return getSherpaLibStatus();
});
ipcMain.handle(
  'download-sherpa-lib',
  async (_e, { source }: { source?: string }) => {
    try {
      const { downloadSherpaLib } = await import(
        './sherpaOnnx/sherpaLibDownloader'
      );
      await downloadSherpaLib(source || 'gitcode', (percent) =>
        mainWindow?.webContents.send('downloadProgress', {
          id: 'sherpa',
          progress: percent,
        }),
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);
ipcMain.handle('remove-sherpa-lib', async () => {
  const { removeSherpaLib } = await import('./sherpaOnnx/sherpaLibManager');
  removeSherpaLib();
  return { success: true };
});
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add main/helpers/ipcEngineHandlers.ts
git commit -m "feat(sherpa): engine IPC switch funasr to sherpa lib (download/status/remove)"
```

## Task PC-3: systemInfo 引擎已装来源改 sherpa

**Files:**

- Modify: `main/helpers/systemInfoManager.ts`

- [ ] **Step 1: `funasrEngineInstalled` 改为 sherpa 库已装**

在 `systemInfoManager.ts` 找到填充 `funasrEngineInstalled` 的位置（原 `isEnginePackageInstalled('funasr')`），改为 `isSherpaLibInstalled()`；顶部 `import { isSherpaLibInstalled } from './sherpaOnnx/sherpaLibPaths';`。`funasrVadInstalled`/`funasrAsrModelsInstalled` 不变。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add main/helpers/systemInfoManager.ts
git commit -m "refactor(systeminfo): funasr engine-installed reflects sherpa lib"
```

## Task PC-4: 引擎管理 UI 接 sherpa 库下载

**Files:**

- Modify: `renderer/components/resources/engines/panels/FunasrPanel.tsx`

- [ ] **Step 1: 把「引擎包下载」替换为「sherpa 运行库下载」**

`FunasrPanel.tsx` 原先触发 `downloadPyEngine('funasr')` / 显示 Python 引擎包状态的部分，改为：

- 状态读 `systemInfo.funasrEngineInstalled`（已是 sherpa 库，PC-3）。
- 下载按钮调用 `window.ipc.invoke('download-sherpa-lib', { source })`；进度监听 `downloadProgress` 的 `id==='sherpa'`。
- 卸载调用 `remove-sherpa-lib`。
- 文案：未装显示「下载 FunASR 运行库（约 30MB，离线运行）」。

> 保持「去模型页下载模型」入口与 ITN/线程参数（`set-funasr-settings`）不变。

- [ ] **Step 2: i18n 文案**

在 `renderer/public/locales/{zh,en}/resources.json` 增 `engines.funasr.downloadRuntime`（zh：「下载 FunASR 运行库」/ en：「Download FunASR runtime」）等所需键。

Run: `npm run check:i18n`
Expected: PASS（zh/en 键齐全）。

- [ ] **Step 3: Commit**

```bash
git add renderer/components/resources/engines/panels/FunasrPanel.tsx renderer/public/locales
git commit -m "feat(ui): funasr panel downloads sherpa runtime lib"
```

## Task PC-5: 引擎仓删除 Python-FunASR（跨仓）

**Files（引擎仓 `smartsub-py-engine`）:**

- Delete: `engines/funasr_sensevoice_engine.py`、`requirements-funasr.txt`
- Modify: `engines/__init__.py`、`.github/workflows/release.yml`、`smoke_test.py`

- [ ] **Step 1: 删 funasr 引擎与依赖**

```bash
git rm engines/funasr_sensevoice_engine.py requirements-funasr.txt
```

- [ ] **Step 2: 注册表/CI/smoke 去 funasr**

- `engines/__init__.py`：删除 funasr 注册分支（`sherpa_onnx` 探测、`get_engine('funasr')`）。
- `release.yml`：从引擎矩阵移除 funasr（仅保留 faster-whisper）。
- `smoke_test.py`：删除 funasr 冒烟。

- [ ] **Step 3: 引擎仓冒烟**

Run（引擎仓）: `python smoke_test.py`
Expected: faster-whisper 通过；无 funasr 引用报错。

- [ ] **Step 4: Commit（引擎仓）**

```bash
git add -A
git commit -m "chore(funasr): remove python funasr engine (moved to node sherpa addon)"
```

## Task PC-6: 全量回归

- [ ] **Step 1: 单测 + 类型 + i18n**

Run: `npm run test:engines && npx tsc --noEmit && npm run check:i18n`
Expected: 全 PASS。

- [ ] **Step 2: 回归冒烟（`npm run dev`）**

1. whisper.cpp（builtin）出 SRT。
2. faster-whisper 出 SRT（Python 三层未受影响）。
3. FunASR（sherpa）SenseVoice/Paraformer 出 SRT；取消正常。
4. 引擎切换、顶部徽标、模型页「当前引擎=FunASR」正确。
5. Windows：FunASR 首次转写不卡 0%。

Expected: 全部满足。

- [ ] **Step 3: 收尾提交（如有 UI/文案微调）**

```bash
git add -A && git commit -m "test(funasr): full regression for sherpa node addon switch"
```

---

## 自审（写完计划后对照 spec）

**1. Spec 覆盖**

- §3 架构 → PA-4/PB-1/PB-2/PB-3。
- §4 原生库分发（方案 B + 引擎仓托管）→ PA-1/PA-2/PA-5/PC-2。
- §5 加载与运行时（loader/vendored/worker 协议/enableExternalBuffer/会话缓存/预热）→ PA-4/PB-1/PB-2/PB-3。
- §6 转写流水线（readWave/VAD/decodeAsync/进度/取消/合并 SRT/语言）→ PB-1/PB-3。
- §7 复用/改接/删除清单 → PA-3(rename)/PB-3/PB-4/PC-1/PC-2/PC-3/PC-4。
- §8 引擎仓清理 → PC-5 + PA-1（新增 CI）。
- §9 跨平台与签名 → PA-5(resignMac)/PB-2(env PATH/LD)。
- §10 参数与能力 → PA-3/PB-3（provider=cpu、itn、vad 映射）。
- §11 错误处理与回退 → PB-3(isAvailable/未装提示)/PB-2(worker error/exit failAll)。
- §12 测试 → PA-3 单测、PA-6/PB-5/PC-6 冒烟、PC-6 回归。
- §13 风险 → 各 Task 内的 env/重签/自检/回归覆盖。
- §14 PA/PB/PC → 三阶段一一对应。

**2. 占位符扫描**：无 TBD/TODO；第三方 vendoring 与跨仓 CI 用「复制/命令」具体动作描述，非占位。所有 mjs/ts/js 代码块均为可直接运行的完整内容。

**3. 类型一致性**：`FunasrAddonParams`（PA-3 改名）在 `sherpaConfig`/`sherpaFunasrRuntime`/`funasrEngine` 一致；`SherpaModelRequest`/`Segment` 在 runtime 与 worker 协议一致；`getSherpaLibDir/isSherpaLibInstalled/getSherpaLibStatus` 在 paths/manager 定义、在 downloader/runtime/engine/ipc/systemInfo 使用，名称统一；`PyEngineId` 去 funasr 后所有使用点（index/autoUpdate/ipc/taskProcessor）均已在 PB-4/PC-1/PC-2 对齐。

> 已知需实现时对齐的外部签名：`MirrorDownloader.download`、`resolveReleaseBaseUrl`、`getSourceFallbackOrder`、`download-sherpa-lib` 的渲染层 `downloadProgress` 事件形状——以现有调用点为准，不改其实现（PA-5 Step 2 已注明）。
