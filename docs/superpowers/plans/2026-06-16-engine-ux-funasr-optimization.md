# Engine UX Refactor + FunASR Multi-Model / Engine-Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-engine layer fully `funasr`-aware (task start, model list, header badge, models page), add a Paraformer Chinese-specialized ASR model to FunASR, let FunASR activate without pre-downloaded models, and redesign engine management into a compact workbench-card + manage-drawer UI.

**Architecture:** Data layer first — extend `ISystemInfo` with FunASR fields and make `engineModels.ts` + `funasrModelCatalog.ts` engine-aware (unlocks task-start and dropdown). Then the cross-repo Python sidecar gains a `model_type` branch (`from_sense_voice` / `from_paraformer`). Then the Models tab gains a FunASR section and the Engines tab is refactored to compact cards + a right-side `Sheet` drawer with per-engine panels.

**Tech Stack:** Electron + Next.js (Pages Router) + TypeScript, next-i18next, shadcn/ui (`Sheet`), Python sidecar with `sherpa-onnx`. Tests: `npm run test:engines` (pure-logic `eq()` harness), `npx tsc --noEmit`, `npm run check:i18n`, manual smoke via `npm run dev`.

**Spec:** `docs/superpowers/specs/2026-06-16-engine-ux-funasr-optimization-design.md`

---

## File Structure

**Created:**

- `renderer/components/resources/engines/EngineWorkbenchCard.tsx` — generic compact engine card (icon, name, badge, chips, scenario, Set-active / Manage buttons).
- `renderer/components/resources/engines/EngineManageDrawer.tsx` — right `Sheet`; routes to a per-engine panel.
- `renderer/components/resources/engines/panels/FasterWhisperPanel.tsx`
- `renderer/components/resources/engines/panels/FunasrPanel.tsx`
- `renderer/components/resources/engines/panels/LocalCliPanel.tsx`
- `renderer/components/resources/engines/panels/BuiltinPanel.tsx`
- `renderer/components/resources/engines/panels/BaseRuntimePanel.tsx`
- `renderer/components/resources/FunasrModelSection.tsx` — FunASR model list (ASR + VAD) for the Models tab.

**Modified:**

- `main/helpers/funasrModelCatalog.ts` — Paraformer entry, `kind`/`modelType`, pure helpers, `isFunasrReady`.
- `main/helpers/engines/funasrEngine.ts` — select ASR model from `formData.model`, inject `model_type`.
- `main/helpers/systemInfoManager.ts` — FunASR fields in `getSystemInfo`, `openModelsFolder` funasr branch.
- `types/types.ts` — `ISystemInfo` FunASR fields.
- `renderer/lib/engineModels.ts` — funasr branches in all four functions.
- `renderer/components/Models.tsx` — `transcriptionEngine` prop type → `TranscriptionEngine`.
- `renderer/components/resources/ModelsTab.tsx` — funasr `ENGINE_OPTIONS`, `EngineContextBar`, render branch, path/open-folder.
- `renderer/components/resources/OverviewTab.tsx` — `engineFunasr` label + funasr engine warning.
- `renderer/components/resources/EnginesTab.tsx` — card grid + drawer orchestration.
- `renderer/components/resources/FunasrEngineCard.tsx` — deleted/folded into `FunasrPanel` + card.
- `renderer/public/locales/{zh,en}/common.json` — `engineBadge.funasr`.
- `renderer/public/locales/{zh,en}/modelsControl.json` — funasr `engineFilter`/`engineModelHint`.
- `renderer/public/locales/{zh,en}/resources.json` — per-engine `scenario`, `engines.funasr.models.paraformer-zh`, `overview.engineFunasr`.
- `scripts/test-engine-units.ts` — unit tests for new pure logic.

**Cross-repo (`/Users/xiaodong/Documents/code/smartsub-py-engine`):**

- `engines/funasr_sensevoice_engine.py` — `model_type` branch.
- `_version.py` — `ENGINE_VERSION` bump.

---

## Task 1: FunASR Catalog — Paraformer + kind/modelType + pure helpers

**Files:**

- Modify: `main/helpers/funasrModelCatalog.ts`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: Write failing tests for the pure catalog helpers**

Append to `scripts/test-engine-units.ts` (after the existing imports add the catalog import; after the last `eq(...)` block and before the final `console.log`):

Add to the import group near the top of the file:

```ts
import {
  getFunasrAsrModelIds,
  resolveFunasrAsrSelection,
} from '../main/helpers/funasrModelCatalog';
```

Add these assertions before the final `console.log(...)`:

```ts
// --- funasr catalog: ASR model ids (VAD excluded) ---
eq(
  getFunasrAsrModelIds().sort().join(','),
  'paraformer-zh,sensevoice-small',
  'funasr: asr ids exclude vad',
);

// --- funasr catalog: resolveFunasrAsrSelection ---
eq(
  resolveFunasrAsrSelection('paraformer-zh', [
    'sensevoice-small',
    'paraformer-zh',
  ]),
  { id: 'paraformer-zh', modelType: 'paraformer' },
  'funasr: requested paraformer resolves',
);
eq(
  resolveFunasrAsrSelection('sensevoice-small', ['sensevoice-small']),
  { id: 'sensevoice-small', modelType: 'sense_voice' },
  'funasr: requested sensevoice resolves',
);
eq(
  resolveFunasrAsrSelection('paraformer-zh', ['sensevoice-small']),
  { id: 'sensevoice-small', modelType: 'sense_voice' },
  'funasr: not-installed request falls back to first installed asr',
);
eq(
  resolveFunasrAsrSelection(undefined, ['paraformer-zh']),
  { id: 'paraformer-zh', modelType: 'paraformer' },
  'funasr: no request uses first installed asr',
);
eq(
  resolveFunasrAsrSelection('sensevoice-small', []),
  null,
  'funasr: no installed asr -> null',
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:engines`
Expected: FAIL — compile error `getFunasrAsrModelIds`/`resolveFunasrAsrSelection` not exported by `funasrModelCatalog`.

- [ ] **Step 3: Implement the catalog changes**

In `main/helpers/funasrModelCatalog.ts`:

Replace the `FunasrModelId` type and `FunasrModelSpec` interface:

```ts
/** funasr 子模型标识（与本地子目录一一对应）。 */
export type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

/** ASR 模型底层类型，决定 sidecar 走 from_sense_voice / from_paraformer。 */
export type FunasrModelType = 'sense_voice' | 'paraformer';

/**
 * 两种下载模式：
 * - repo：从 HF（镜像）仓库按 tree 下载子集（keepFiles）。
 * - files：按显式候选 URL 顺序回退下单个文件（silero 这类 release 资产）。
 */
export interface FunasrModelSpec {
  id: FunasrModelId;
  dirName: string;
  /** 'asr' 进入模型下拉并参与转写；'vad' 为共用基础组件，不进下拉。 */
  kind: 'asr' | 'vad';
  /** ASR 模型的底层加载类型（kind==='asr' 时必填）。 */
  modelType?: FunasrModelType;
  /** 判定「已安装」必须存在的关键文件 */
  requiredFiles: string[];
  /** HF（镜像）仓库 id（repo 模式） */
  repo?: string;
  /** 仅保留这些文件，省带宽（repo 模式；缺省下载全部非点文件） */
  keepFiles?: string[];
  /** 单文件候选 URL（files 模式，按序回退） */
  files?: { name: string; urls: string[] }[];
}
```

Replace the `FUNASR_MODELS` constant with the version including `kind`/`modelType` and the new `paraformer-zh` entry:

```ts
export const FUNASR_MODELS: Record<FunasrModelId, FunasrModelSpec> = {
  'sensevoice-small': {
    id: 'sensevoice-small',
    dirName: 'sensevoice-small',
    kind: 'asr',
    modelType: 'sense_voice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    keepFiles: ['model.int8.onnx', 'tokens.txt'],
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
  'paraformer-zh': {
    id: 'paraformer-zh',
    dirName: 'paraformer-zh',
    kind: 'asr',
    modelType: 'paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09',
    keepFiles: ['model.int8.onnx', 'tokens.txt'],
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
  'silero-vad': {
    id: 'silero-vad',
    dirName: 'silero-vad',
    kind: 'vad',
    requiredFiles: ['silero_vad.onnx'],
    files: [
      {
        name: 'silero_vad.onnx',
        urls: [
          'https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx',
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
          'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
          'https://huggingface.co/csukuangfj/vad/resolve/main/silero_vad.onnx',
        ],
      },
    ],
  },
};
```

Replace the `isFunasrReady` function and add the new pure + fs helpers (place after `isFunasrModelInstalled`):

```ts
/** 全部 ASR 模型 id（静态，纯函数，不触磁盘）。 */
export function getFunasrAsrModelIds(): FunasrModelId[] {
  return (Object.keys(FUNASR_MODELS) as FunasrModelId[]).filter(
    (id) => FUNASR_MODELS[id].kind === 'asr',
  );
}

/** 已安装的 ASR 模型 id（触磁盘）。 */
export function getInstalledFunasrAsrModels(): FunasrModelId[] {
  return getFunasrAsrModelIds().filter((id) => isFunasrModelInstalled(id));
}

/**
 * 选定要使用的 ASR 模型（纯函数）：
 * - requested 命中已装 ASR → 用它；
 * - 否则回退首个已装 ASR；
 * - 无已装 ASR → null。
 */
export function resolveFunasrAsrSelection(
  requested: string | undefined,
  installedAsr: FunasrModelId[],
): { id: FunasrModelId; modelType: FunasrModelType } | null {
  if (installedAsr.length === 0) return null;
  const asrIds = getFunasrAsrModelIds();
  const normalized = (requested || '').toLowerCase();
  const chosen =
    asrIds.find((id) => id === normalized && installedAsr.includes(id)) ??
    installedAsr[0];
  return {
    id: chosen,
    modelType: FUNASR_MODELS[chosen].modelType ?? 'sense_voice',
  };
}

/** funasr 转写就绪 = VAD + 至少一个 ASR 模型已安装。 */
export function isFunasrReady(): boolean {
  return (
    isFunasrModelInstalled('silero-vad') &&
    getInstalledFunasrAsrModels().length > 0
  );
}
```

Delete the old `isFunasrReady` (the one referencing only `sensevoice-small`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:engines`
Expected: PASS — `engine unit tests: N passed, 0 failed` (N increased by 6).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add main/helpers/funasrModelCatalog.ts scripts/test-engine-units.ts
git commit -m "feat(funasr): add paraformer model + kind/modelType catalog helpers"
```

---

## Task 2: systemInfo — FunASR fields + open-folder branch

**Files:**

- Modify: `types/types.ts`
- Modify: `main/helpers/systemInfoManager.ts`

- [ ] **Step 1: Add FunASR fields to `ISystemInfo`**

In `types/types.ts`, inside `ISystemInfo` (after `pythonEngineStatus?`):

```ts
  /** funasr 引擎包是否已安装 */
  funasrEngineInstalled?: boolean;
  /** funasr 共用 VAD 是否已安装 */
  funasrVadInstalled?: boolean;
  /** 已安装的 funasr ASR 模型 id（如 ['sensevoice-small','paraformer-zh']） */
  funasrAsrModelsInstalled?: string[];
```

- [ ] **Step 2: Populate them in `getSystemInfo`**

In `main/helpers/systemInfoManager.ts`, update the import from `./funasrModelCatalog` to include the new helpers:

```ts
import {
  FUNASR_MODELS,
  FunasrModelId,
  isFunasrModelInstalled,
  isFunasrReady,
  deleteFunasrModel,
  getInstalledFunasrAsrModels,
} from './funasrModelCatalog';
```

In the `getSystemInfo` handler return object, add the three fields after `pythonEngineStatus`:

```ts
      pythonEngineStatus,
      funasrEngineInstalled: isEnginePackageInstalled('funasr'),
      funasrVadInstalled: isFunasrModelInstalled('silero-vad'),
      funasrAsrModelsInstalled: getInstalledFunasrAsrModels(),
```

- [ ] **Step 3: Add the funasr branch to `openModelsFolder`**

In `main/helpers/systemInfoManager.ts`, add `getFunasrModelsRoot` to the catalog import (extend the import edited in Step 2 with `getFunasrModelsRoot`), then replace the `openModelsFolder` handler body:

```ts
ipcMain.handle(
  'openModelsFolder',
  async (_event, options?: { pathType?: 'ggml' | 'ct2' | 'funasr' }) => {
    const modelsPath =
      options?.pathType === 'ct2'
        ? getFasterWhisperModelsPath()
        : options?.pathType === 'funasr'
          ? getFunasrModelsRoot()
          : (getPath('modelsPath') as string);
    try {
      await fse.ensureDir(modelsPath);
      const err = await shell.openPath(modelsPath);
      if (err) {
        return { success: false, error: err };
      }
      return { success: true };
    } catch (error) {
      logMessage(`Failed to open models folder: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  },
);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add types/types.ts main/helpers/systemInfoManager.ts
git commit -m "feat(funasr): expose funasr model status in systemInfo + open-folder"
```

---

## Task 3: engineModels funasr awareness + Models.tsx type

**Files:**

- Modify: `renderer/lib/engineModels.ts`
- Modify: `renderer/components/Models.tsx`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: Write failing tests for funasr branches**

Add to the import group at the top of `scripts/test-engine-units.ts`:

```ts
import {
  getSelectableModelsForEngine,
  getInstalledModelsForEngine,
  hasModelsForEngine,
} from '../renderer/lib/engineModels';
```

Add these assertions before the final `console.log(...)`:

```ts
// --- engineModels: funasr awareness ---
const funasrReady = {
  transcriptionEngine: 'funasr' as const,
  funasrVadInstalled: true,
  funasrAsrModelsInstalled: ['sensevoice-small', 'paraformer-zh'],
};
eq(
  getSelectableModelsForEngine(funasrReady),
  ['sensevoice-small', 'paraformer-zh'],
  'engineModels: funasr selectable = installed asr',
);
eq(
  getInstalledModelsForEngine(funasrReady),
  ['sensevoice-small', 'paraformer-zh'],
  'engineModels: funasr installed = installed asr',
);
eq(
  hasModelsForEngine(funasrReady),
  true,
  'engineModels: funasr ready w/ vad+asr',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'funasr',
    funasrVadInstalled: false,
    funasrAsrModelsInstalled: ['sensevoice-small'],
  }),
  false,
  'engineModels: funasr not ready without vad',
);
eq(
  hasModelsForEngine({
    transcriptionEngine: 'funasr',
    funasrVadInstalled: true,
    funasrAsrModelsInstalled: [],
  }),
  false,
  'engineModels: funasr not ready without asr',
);
eq(
  getSelectableModelsForEngine({ transcriptionEngine: 'funasr' }),
  [],
  'engineModels: funasr selectable empty when undefined',
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:engines`
Expected: FAIL — funasr selectable returns `[]`/`modelsInstalled` instead of asr list (assertions mismatch), and `EngineModelInfo` lacks the new fields (compile error).

- [ ] **Step 3: Implement funasr branches**

In `renderer/lib/engineModels.ts`, extend `EngineModelInfo`:

```ts
export interface EngineModelInfo {
  transcriptionEngine?: TranscriptionEngine;
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
  funasrVadInstalled?: boolean;
  funasrAsrModelsInstalled?: string[];
}
```

Add a funasr branch to `getInstalledModelsForEngine` (before the final `return`):

```ts
if (engine === 'funasr') {
  return info?.funasrAsrModelsInstalled ?? [];
}
```

Add the same funasr branch to `getSelectableModelsForEngine` (before the final `return`):

```ts
if (engine === 'funasr') {
  return info?.funasrAsrModelsInstalled ?? [];
}
```

Replace `hasModelsForEngine` so funasr requires VAD + ≥1 ASR:

```ts
/** 当前引擎是否已就绪可开始转写 */
export function hasModelsForEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): boolean {
  const engine = resolveEngine(info, useLocalWhisper);
  if (engine === 'localCli') return true;
  if (engine === 'funasr') {
    return (
      !!info?.funasrVadInstalled &&
      (info?.funasrAsrModelsInstalled?.length ?? 0) > 0
    );
  }
  return getInstalledModelsForEngine(info, useLocalWhisper).length > 0;
}
```

- [ ] **Step 4: Update `Models.tsx` prop type**

In `renderer/components/Models.tsx`, add the import and widen the prop:

```ts
import { getSelectableModelsForEngine, resolveEngine } from 'lib/engineModels';
import type { TranscriptionEngine } from '../../types/engine';
```

Change `IProps`:

```ts
interface IProps {
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
  funasrVadInstalled?: boolean;
  funasrAsrModelsInstalled?: string[];
  transcriptionEngine?: TranscriptionEngine;
  useLocalWhisper?: boolean;
}
```

Update the `engineInfo` object built inside the component to pass the funasr fields through:

```ts
const engineInfo = {
  transcriptionEngine: props.transcriptionEngine,
  modelsInstalled: props.modelsInstalled,
  fasterWhisperModelsInstalled: props.fasterWhisperModelsInstalled,
  funasrVadInstalled: props.funasrVadInstalled,
  funasrAsrModelsInstalled: props.funasrAsrModelsInstalled,
};
```

- [ ] **Step 5: Pass funasr fields from `InlineConfigBar` to `Models`**

In `renderer/components/tasks/InlineConfigBar.tsx`, in the `<Models ... />` usage, add two props after `fasterWhisperModelsInstalled`:

```tsx
              fasterWhisperModelsInstalled={
                systemInfo?.fasterWhisperModelsInstalled
              }
              funasrVadInstalled={systemInfo?.funasrVadInstalled}
              funasrAsrModelsInstalled={systemInfo?.funasrAsrModelsInstalled}
              transcriptionEngine={systemInfo?.transcriptionEngine}
              useLocalWhisper={useLocalWhisper}
```

- [ ] **Step 6: Run tests + type-check**

Run: `npm run test:engines`
Expected: PASS — N increased by 6.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add renderer/lib/engineModels.ts renderer/components/Models.tsx renderer/components/tasks/InlineConfigBar.tsx scripts/test-engine-units.ts
git commit -m "feat(funasr): engine-aware model selection for funasr (task start + dropdown)"
```

---

## Task 4: FunASR adapter — select ASR model by `formData.model` + inject `model_type`

**Files:**

- Modify: `main/helpers/engines/funasrEngine.ts`

- [ ] **Step 1: Update imports**

In `main/helpers/engines/funasrEngine.ts`, replace the funasr catalog import:

```ts
import {
  getFunasrModelDir,
  isFunasrReady,
  getInstalledFunasrAsrModels,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
```

- [ ] **Step 2: Use the selected ASR model in `transcribeFunasr`**

Replace the model-resolution + params block (currently the `const asrDir = getFunasrModelDir('sensevoice-small'); const params = {...}` section) with:

```ts
const installedAsr = getInstalledFunasrAsrModels();
const selection = resolveFunasrAsrSelection(
  (formData as { model?: string })?.model,
  installedAsr,
);
if (!selection) {
  throw new Error(
    'funasr ASR model not installed. Download SenseVoice or Paraformer from Resource Hub > Models.',
  );
}

const asrDir = getFunasrModelDir(selection.id);
const params = {
  engine: 'funasr',
  audio_file: tempAudioFile,
  asr_model: path.join(asrDir, 'model.int8.onnx'),
  tokens: path.join(asrDir, 'tokens.txt'),
  vad_model: path.join(getFunasrModelDir('silero-vad'), 'silero_vad.onnx'),
  model_type: selection.modelType,
  ...buildFunasrParams(settings, sourceLanguage),
};
```

> Note: both SenseVoice and Paraformer use file names `model.int8.onnx` + `tokens.txt` (per catalog `keepFiles`), so only the directory and `model_type` differ. `model_type` is injected by the adapter (not by `buildFunasrParams`, which only maps settings).

- [ ] **Step 3: Update the displayName (optional clarity)**

Change the adapter's `displayName` to reflect multi-model:

```ts
  displayName: 'FunASR (SenseVoice / Paraformer)',
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add main/helpers/engines/funasrEngine.ts
git commit -m "feat(funasr): pick ASR model from task selection + pass model_type to sidecar"
```

---

## Task 5: Python sidecar — Paraformer branch + version bump (cross-repo)

**Repo:** `/Users/xiaodong/Documents/code/smartsub-py-engine`
**Files:**

- Modify: `engines/funasr_sensevoice_engine.py`
- Modify: `_version.py`

- [ ] **Step 1: Add the `model_type` branch to `_build_recognizer`**

In `engines/funasr_sensevoice_engine.py`, replace `_build_recognizer` with:

```python
def _build_recognizer(sherpa_onnx, params):
    asr_model = params.get("asr_model")
    tokens = params.get("tokens")
    if not asr_model or not tokens:
        raise EngineError("invalid_params", "asr_model and tokens are required")

    model_type = params.get("model_type") or "sense_voice"
    num_threads = int(params.get("num_threads", 2))
    provider = params.get("provider") or "cpu"

    if model_type == "paraformer":
        return sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=asr_model,
            tokens=tokens,
            num_threads=num_threads,
            sample_rate=TARGET_SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
            provider=provider,
            debug=False,
        )

    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=asr_model,
        tokens=tokens,
        num_threads=num_threads,
        sample_rate=TARGET_SAMPLE_RATE,
        use_itn=bool(params.get("use_itn", True)),
        language=_normalize_language(params.get("language")),
        provider=provider,
        debug=False,
    )
```

- [ ] **Step 2: Include `model_type` in the recognizer cache key**

Replace the `key = (...)` tuple in `_get_recognizer` with:

```python
    key = (
        params.get("model_type") or "sense_voice",
        params.get("asr_model"),
        params.get("tokens"),
        int(params.get("num_threads", 2)),
        bool(params.get("use_itn", True)),
        _normalize_language(params.get("language")),
        params.get("provider") or "cpu",
    )
```

- [ ] **Step 3: Bump the engine version**

In `_version.py`, change:

```python
ENGINE_VERSION = "0.3.0"
```

(`PROTOCOL_VERSION` stays `1` — no protocol change.)

- [ ] **Step 4: Smoke test (manual, requires models)**

Run (from the engine repo, with sherpa-onnx installed): `python smoke_test.py`
Expected: existing engines still import and run. Paraformer end-to-end is a manual smoke once a Paraformer model is downloaded by the app (covered in Task 10 manual smoke).

- [ ] **Step 5: Commit (engine repo)**

```bash
cd /Users/xiaodong/Documents/code/smartsub-py-engine
git add engines/funasr_sensevoice_engine.py _version.py
git commit -m "feat(funasr): support paraformer via from_paraformer + bump engine version"
```

- [ ] **Step 6: Publish / install for the app**

Push the engine-repo branch so CI publishes the `latest` engine package, OR build locally and copy into userData (same flow as P1). The app then sees the new FunASR engine package via "Check for updates" / re-download. The SmartSub side requires no code change to consume it (sidecar is inside the funasr package).

```bash
git push
```

---

## Task 6: i18n — engineBadge, modelsControl, resources (funasr + scenarios + paraformer)

**Files:**

- Modify: `renderer/public/locales/{zh,en}/common.json`
- Modify: `renderer/public/locales/{zh,en}/modelsControl.json`
- Modify: `renderer/public/locales/{zh,en}/resources.json`

- [ ] **Step 1: `engineBadge.funasr` (header badge — fixes point 5)**

`renderer/public/locales/zh/common.json` — in `engineBadge`, add after `fasterWhisper`:

```json
    "funasr": "FunASR",
```

`renderer/public/locales/en/common.json` — in `engineBadge`, add after `fasterWhisper`:

```json
    "funasr": "FunASR",
```

- [ ] **Step 2: `modelsControl` funasr filter + hint (fixes point 6)**

`renderer/public/locales/zh/modelsControl.json` — add `funasr` into `engineFilter` and `engineModelHint`:

In `engineFilter` (after `fasterWhisper`):

```json
    "funasr": "FunASR",
```

In `engineModelHint` (after `fasterWhisper`):

```json
    "funasr": "以下为 FunASR 模型：SenseVoice 多语种、Paraformer 中文专精，及共用的 VAD 组件",
```

`renderer/public/locales/en/modelsControl.json` — same keys:

In `engineFilter` (after `fasterWhisper`):

```json
    "funasr": "FunASR",
```

In `engineModelHint` (after `fasterWhisper`):

```json
    "funasr": "FunASR models: SenseVoice multilingual, Paraformer for Chinese, and the shared VAD component",
```

- [ ] **Step 3: per-engine `scenario` chips + Paraformer model + overview label (zh)**

`renderer/public/locales/zh/resources.json`:

In `engines.builtin` add:

```json
    "scenario": "适合：Mac / 老旧设备 / 离线通用转写",
```

In `engines.fasterWhisper` add:

```json
    "scenario": "适合：NVIDIA 显卡 / 追求速度与精度",
```

In `engines.funasr` add `scenario` and update `name`/`desc` (now multi-model, not SenseVoice-only):

```json
    "name": "FunASR",
    "desc": "阿里达摩院中文/多语种 ASR 引擎，基于 sherpa-onnx 运行：SenseVoice 多语种、Paraformer 中文专精，自带标点与逆文本规整；CPU 即可流畅运行，无需显卡。",
    "scenario": "适合：中文 / 粤语 / 日韩，CPU 离线高准确率",
```

In `engines.localCli` add:

```json
    "scenario": "适合：进阶用户，自备 Whisper 命令与模型",
```

In `engines.funasr.models`, add a `paraformer-zh` entry after `sensevoice-small`:

```json
        "paraformer-zh": {
          "name": "Paraformer 中文（约 230MB）",
          "desc": "中文专精识别模型（中英双语），中文准确率高、速度快"
        },
```

In `overview`, add after `engineFasterWhisper`:

```json
    "engineFunasr": "FunASR",
```

- [ ] **Step 4: per-engine `scenario` + Paraformer model + overview label (en)**

`renderer/public/locales/en/resources.json`:

In `engines.builtin` add:

```json
    "scenario": "Best for: Mac / older devices / general offline transcription",
```

In `engines.fasterWhisper` add:

```json
    "scenario": "Best for: NVIDIA GPUs / speed and accuracy",
```

In `engines.funasr` add `scenario` and update `name`/`desc` (now multi-model, not SenseVoice-only):

```json
    "name": "FunASR",
    "desc": "Alibaba DAMO Chinese/multilingual ASR engine on sherpa-onnx: SenseVoice multilingual and Paraformer for Chinese, with built-in punctuation and inverse text normalization. Runs smoothly on CPU — no GPU required.",
    "scenario": "Best for: Chinese / Cantonese / JA-KO, high accuracy on CPU",
```

In `engines.localCli` add:

```json
    "scenario": "Best for: advanced users with their own Whisper CLI and models",
```

In `engines.funasr.models`, add after `sensevoice-small`:

```json
        "paraformer-zh": {
          "name": "Paraformer Chinese (~230MB)",
          "desc": "Chinese-specialized model (ZH+EN) with high Chinese accuracy and speed"
        },
```

In `overview`, add after `engineFasterWhisper`:

```json
    "engineFunasr": "FunASR",
```

- [ ] **Step 5: Verify i18n parity**

Run: `npm run check:i18n`
Expected: `✓ i18n check passed: zh/en key parity OK, no fallback patterns`

- [ ] **Step 6: Commit**

```bash
git add renderer/public/locales/zh/common.json renderer/public/locales/en/common.json renderer/public/locales/zh/modelsControl.json renderer/public/locales/en/modelsControl.json renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json
git commit -m "feat(i18n): add funasr engine badge, model-page hints, scenarios, paraformer labels"
```

---

## Task 7: Models tab — FunASR section + engine-aware context bar/path

**Files:**

- Create: `renderer/components/resources/FunasrModelSection.tsx`
- Modify: `renderer/components/resources/ModelsTab.tsx`

- [ ] **Step 1: Create `FunasrModelSection.tsx`**

This component owns the FunASR model list (ASR models + VAD) in the Models tab. It reuses the existing IPC (`getFunasrModelStatus`, `downloadFunasrModel`, `deleteFunasrModel`, `cancelModelDownload`) and the `downloadProgress` `funasr:<id>` events.

Create `renderer/components/resources/FunasrModelSection.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  Download,
  Trash2,
  X,
  AlertTriangle,
  Mic,
  Waves,
} from 'lucide-react';
import { toast } from 'sonner';

type FunasrModelId = 'sensevoice-small' | 'paraformer-zh' | 'silero-vad';

interface FunasrModelStatus {
  baseReady: boolean;
  engineInstalled: boolean;
  ready: boolean;
  models: { id: FunasrModelId; installed: boolean }[];
}

const ASR_MODELS: FunasrModelId[] = ['sensevoice-small', 'paraformer-zh'];
const VAD_MODEL: FunasrModelId = 'silero-vad';

const FunasrModelSection: React.FC<{ onUpdate?: () => void }> = ({
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const { t: mc } = useTranslation('modelsControl');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<FunasrModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<FunasrModelId | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getFunasrModelStatus');
      if (r?.success) setStatus(r as FunasrModelStatus);
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (typeof key !== 'string' || !key.startsWith('funasr:')) return;
        setProgress((prev) => ({ ...prev, [key]: value }));
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    return () => {
      unsub?.();
    };
  }, [load, onUpdate]);

  const isInstalled = (id: FunasrModelId) =>
    status?.models.find((m) => m.id === id)?.installed ?? false;

  const handleDownload = async (id: FunasrModelId) => {
    setDownloading(id);
    try {
      const r = await window?.ipc?.invoke('downloadFunasrModel', {
        model: id,
        source: 'hf-mirror',
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.funasr.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(null);
      setProgress((prev) => ({ ...prev, [`funasr:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleDelete = async (id: FunasrModelId) => {
    const r = await window?.ipc?.invoke('deleteFunasrModel', id);
    if (r?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(r?.error || 'Failed to delete model');
    }
  };

  const engineInstalled = status?.engineInstalled ?? false;

  const renderRow = (id: FunasrModelId, Icon: typeof Mic) => {
    const installed = isInstalled(id);
    const isBusy = downloading === id;
    const pct = Math.round((progress[`funasr:${id}`] ?? 0) * 100);
    return (
      <div
        key={id}
        className="flex items-center justify-between gap-3 rounded-lg border border-muted p-3"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {t(`engines.funasr.models.${id}.name`)}
              {installed && (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`engines.funasr.models.${id}.desc`)}
            </p>
            {isBusy && (
              <div className="mt-1.5 w-40">
                <Progress value={pct} />
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {isBusy ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={handleCancel}
            >
              <X className="h-3.5 w-3.5" />
              {commonT('cancel')}
            </Button>
          ) : installed ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDelete')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={!!downloading}
              onClick={() => handleDownload(id)}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDownload')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  if (!engineInstalled) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{mc('engineNotInstalled')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Mic className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t('engines.funasr.modelsTitle')}
          </h3>
        </div>
        <Card>
          <CardContent className="space-y-2 p-2">
            {ASR_MODELS.map((id) => renderRow(id, Mic))}
          </CardContent>
        </Card>
      </section>
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <Waves className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">VAD</h3>
          <Badge variant="outline" className="text-[10px]">
            {t('engines.funasr.needModelsHint')}
          </Badge>
        </div>
        <Card>
          <CardContent className="p-2">
            {renderRow(VAD_MODEL, Waves)}
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default FunasrModelSection;
```

- [ ] **Step 2: Make `ModelsTab` funasr-aware (ENGINE_OPTIONS + EngineContextBar)**

In `renderer/components/resources/ModelsTab.tsx`:

Add `Languages` to the lucide import list (the big import block at top) and import the new section:

```ts
import FunasrModelSection from '@/components/resources/FunasrModelSection';
```

Extend `ENGINE_OPTIONS`:

```ts
const ENGINE_OPTIONS: Array<{
  id: TranscriptionEngine;
  icon: typeof Box;
}> = [
  { id: 'builtin', icon: Box },
  { id: 'fasterWhisper', icon: Zap },
  { id: 'funasr', icon: Languages },
  { id: 'localCli', icon: Terminal },
];
```

In `EngineContextBar`, replace the `engineKey` computation so funasr maps to itself:

```ts
const engineKey =
  engine === 'builtin'
    ? 'builtin'
    : engine === 'fasterWhisper'
      ? 'fasterWhisper'
      : engine === 'funasr'
        ? 'funasr'
        : 'localCli';
```

- [ ] **Step 3: Add the funasr render branch + flags**

In `ModelsTab`'s body, add a funasr flag next to the existing ones:

```ts
const isBuiltin = transcriptionEngine === 'builtin';
const isFasterWhisper = transcriptionEngine === 'fasterWhisper';
const isFunasr = transcriptionEngine === 'funasr';
const isLocalCli = transcriptionEngine === 'localCli';
```

Replace the final render chain (currently `isLocalCli ? ... : installedOnly && !hasAnyInstalled ? ... : trimmedQuery && !hasVisibleModels ? ... : isBuiltin ? (...) : (CT2 ...)`) so funasr renders the new section. Insert the funasr case as the first branch after `isLocalCli`:

```tsx
        {isLocalCli ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('localCliModelHint')}
          </p>
        ) : isFunasr ? (
          <FunasrModelSection onUpdate={updateSystemInfo} />
        ) : installedOnly && !hasAnyInstalled ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('noInstalledModels')}
          </p>
        ) : trimmedQuery && !hasVisibleModels ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('noModelMatch')}
          </p>
        ) : isBuiltin ? (
```

- [ ] **Step 4: Engine-aware open-folder for funasr (single coherent edit)**

Decision: for funasr, hide the editable path string and the "change path" link (FunASR uses a fixed `models/funasr` root, no relocation); keep an "Open folder" link that opens that root via `pathType: 'funasr'`. Do **not** add a new systemInfo path field.

Replace the path value span so funasr shows no path text:

```tsx
<span className="font-mono break-all">
  {isFasterWhisper
    ? systemInfo.fasterWhisperModelsPath
    : isFunasr
      ? ''
      : systemInfo?.modelsPath}
</span>
```

Replace the open/change buttons condition so funasr gets "Open folder" only (no "Change path"):

```tsx
{
  (isBuiltin || isFasterWhisper || isFunasr) && (
    <>
      <button
        type="button"
        onClick={handleOpenModelsFolder}
        className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
      >
        <FolderOpen className="h-3 w-3" />
        <span>{t('openModelsFolder')}</span>
      </button>
      {!isFunasr && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={handleChangeModelsPath}
            className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
          >
            <span>{t('changePath')}</span>
          </button>
        </>
      )}
    </>
  );
}
```

Update `handleOpenModelsFolder` to pass the funasr path type:

```ts
const handleOpenModelsFolder = async () => {
  try {
    const result = await window?.ipc?.invoke('openModelsFolder', {
      pathType: isFasterWhisper ? 'ct2' : isFunasr ? 'funasr' : 'ggml',
    });
    if (!result?.success) {
      toast.error(
        t('openFolderFailed', {
          error: result?.error || t('unknownError'),
        }),
      );
    }
  } catch (error) {
    console.error('Failed to open models folder:', error);
    toast.error(
      t('openFolderFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};
```

Note: `showRecommendedHero` is already false for funasr (it's neither builtin nor fasterWhisper), so the recommended hero is hidden automatically. The sticky search box stays (harmless — `FunasrModelSection` ignores it) and `importModel` is already gated on `isBuiltin`. No further changes needed.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/resources/FunasrModelSection.tsx renderer/components/resources/ModelsTab.tsx
git commit -m "feat(funasr): manage funasr models in Models tab + engine-aware context bar"
```

---

## Task 8: OverviewTab — funasr label + engine warning

**Files:**

- Modify: `renderer/components/resources/OverviewTab.tsx`

- [ ] **Step 1: Add the funasr label key**

In `renderer/components/resources/OverviewTab.tsx`, extend `ENGINE_LABEL_KEYS`:

```ts
const ENGINE_LABEL_KEYS = {
  builtin: 'overview.engineBuiltin',
  fasterWhisper: 'overview.engineFasterWhisper',
  funasr: 'overview.engineFunasr',
  localCli: 'overview.engineLocalCli',
} as const;
```

- [ ] **Step 2: Make the engine warning funasr-aware**

Replace the `showEngineWarning` computation:

```ts
const showEngineWarning =
  (transcriptionEngine === 'fasterWhisper' &&
    systemInfo.pythonEngineStatus?.state !== 'ready') ||
  (transcriptionEngine === 'funasr' && !systemInfo.funasrEngineInstalled);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add renderer/components/resources/OverviewTab.tsx
git commit -m "feat(funasr): overview tab recognizes funasr engine label + readiness"
```

---

## Task 9: Engines tab — workbench cards + manage drawer (incl. FunASR activate-without-models)

This is the largest task. It keeps all engine state/handlers in `EnginesTab.tsx`, renders a grid of compact `EngineWorkbenchCard`s, and moves every engine's configuration body into a right-side `EngineManageDrawer` that renders a per-engine panel.

**Files:**

- Create: `renderer/components/resources/engines/EngineWorkbenchCard.tsx`
- Create: `renderer/components/resources/engines/EngineManageDrawer.tsx`
- Create: `renderer/components/resources/engines/panels/FasterWhisperPanel.tsx`
- Create: `renderer/components/resources/engines/panels/FunasrPanel.tsx`
- Create: `renderer/components/resources/engines/panels/LocalCliPanel.tsx`
- Create: `renderer/components/resources/engines/panels/BuiltinPanel.tsx`
- Create: `renderer/components/resources/engines/panels/BaseRuntimePanel.tsx`
- Modify: `renderer/components/resources/EnginesTab.tsx`
- Delete: `renderer/components/resources/FunasrEngineCard.tsx` (logic split into `FunasrPanel` + card)

- [ ] **Step 1: Create `EngineWorkbenchCard.tsx` (full code)**

```tsx
import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Power, Settings2, Check } from 'lucide-react';
import { cn } from 'lib/utils';

export interface EngineWorkbenchCardProps {
  isActive: boolean;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  recommended?: boolean;
  recommendedLabel?: string;
  chips: string[];
  desc: string;
  scenario?: string;
  badge: React.ReactNode;
  activeLabel: string;
  setActiveLabel: string;
  manageLabel: string;
  canSetActive: boolean;
  setActiveDisabled?: boolean;
  showManage?: boolean;
  onSetActive: () => void;
  onManage: () => void;
}

/** 紧凑「工作台」引擎卡片：一屏看全引擎，操作收敛为 设为当前 / 管理。 */
const EngineWorkbenchCard: React.FC<EngineWorkbenchCardProps> = ({
  isActive,
  icon: Icon,
  name,
  recommended,
  recommendedLabel,
  chips,
  desc,
  scenario,
  badge,
  activeLabel,
  setActiveLabel,
  manageLabel,
  canSetActive,
  setActiveDisabled,
  showManage = true,
  onSetActive,
  onManage,
}) => {
  return (
    <Card
      className={cn(
        'relative flex flex-col overflow-hidden transition-all',
        isActive && 'border-primary/60 bg-primary/[0.03] shadow-sm',
      )}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-primary"
        />
      )}
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-base font-semibold leading-tight">
                {name}
                {recommended && recommendedLabel && (
                  <Badge
                    variant="outline"
                    className="border-primary/40 px-1.5 py-0 text-[10px] font-medium text-primary"
                  >
                    {recommendedLabel}
                  </Badge>
                )}
              </p>
              {chips.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {badge}
        </div>

        <p className="text-sm text-muted-foreground">{desc}</p>
        {scenario && (
          <p className="text-xs font-medium text-muted-foreground/90">
            {scenario}
          </p>
        )}

        <div className="mt-auto flex items-center gap-2 pt-1">
          {isActive ? (
            <Badge className="gap-1">
              <Check className="h-3 w-3" />
              {activeLabel}
            </Badge>
          ) : (
            canSetActive && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={setActiveDisabled}
                onClick={onSetActive}
              >
                <Power className="h-3.5 w-3.5" />
                {setActiveLabel}
              </Button>
            )
          )}
          {showManage && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={onManage}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {manageLabel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default EngineWorkbenchCard;
```

- [ ] **Step 2: Create the panels by extracting existing config bodies**

Each panel is a presentational component that receives state + handlers via props from `EnginesTab` and renders the configuration UI currently inlined in `EnginesTab.tsx` / `FunasrEngineCard.tsx`. Use these prop interfaces and move the corresponding JSX.

`renderer/components/resources/engines/panels/BuiltinPanel.tsx` (full code — builtin has no engine download):

```tsx
import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Bot } from 'lucide-react';

const BuiltinPanel: React.FC<{ onGoModels?: () => void }> = ({
  onGoModels,
}) => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.builtin.desc')}
      </p>
      {onGoModels && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onGoModels}
        >
          <Bot className="h-3.5 w-3.5" />
          {t('overview.modelsTitle')}
        </Button>
      )}
    </div>
  );
};

export default BuiltinPanel;
```

`renderer/components/resources/engines/panels/LocalCliPanel.tsx` (full code — move the command-config JSX from `EnginesTab.tsx` lines ~804–871):

```tsx
import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Check, Info } from 'lucide-react';

interface LocalCliPanelProps {
  whisperCommand: string;
  onCommandChange: (value: string) => void;
  onSave: () => void;
}

const LocalCliPanel: React.FC<LocalCliPanelProps> = ({
  whisperCommand,
  onCommandChange,
  onSave,
}) => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t('engines.localCli.desc')}
      </p>
      <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-1.5">
          <label htmlFor="localcli-command" className="text-sm font-medium">
            {t('engines.localCli.commandLabel')}
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('engines.localCli.commandLabel')}
                className="text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
              {t('engines.localCli.commandTooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex gap-2">
          <Input
            id="localcli-command"
            value={whisperCommand}
            onChange={(e) => onCommandChange(e.target.value)}
            placeholder={t('engines.localCli.commandPlaceholder')}
            className="font-mono text-sm"
          />
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onSave}>
            <Check className="h-3.5 w-3.5" />
            {t('engines.localCli.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('engines.localCli.commandHint')}
        </p>
      </div>
    </div>
  );
};

export default LocalCliPanel;
```

`renderer/components/resources/engines/panels/FasterWhisperPanel.tsx`: define this prop interface, then move the faster-whisper body JSX currently at `EnginesTab.tsx` lines ~640–781 (the download/verify/repair/uninstall buttons, version + check-update/upgrade row, serial note, and the `advancedSettings` Collapsible) into the component's `return`, replacing local references with the props below:

```tsx
interface FasterWhisperPanelProps {
  status?: import('../../../../../types/engine').EngineStatus;
  isDownloading: boolean;
  downloadProgress:
    | import('../../../../../types/engine').PyEngineDownloadProgress
    | null;
  showVerifying: boolean;
  fasterInstalled: boolean;
  fasterBroken: boolean;
  hasUpdate: boolean;
  checkingUpdate: boolean;
  taskBusy: boolean;
  device: string;
  computeType: string;
  deviceOptions: string[];
  updateInfo: import('../../../../../types/engine').PyEngineUpdateInfo | null;
  onDownload: () => void; // sets pendingActivate=true + opens download confirm
  onRepair: () => void; // pendingActivate=false + opens download confirm
  onUninstall: () => void;
  onCheckUpdate: () => void;
  onUpgrade: () => void; // opens upgrade confirm
  onDeviceChange: (v: string) => void;
  onComputeTypeChange: (v: string) => void;
}
```

> Mechanical move: the JSX block already exists verbatim in `EnginesTab.tsx`. Replace inline state reads (`fasterStatus`→`status`, the `setShowDownloadConfirm`/`pendingActivateRef` calls → `onDownload`/`onRepair`, `handleUninstall`→`onUninstall`, `handleCheckUpdate`→`onCheckUpdate`, `setShowUpgradeConfirm(true)`→`onUpgrade`, `handleDeviceChange`→`onDeviceChange`, `handleComputeTypeChange`→`onComputeTypeChange`, `deviceValue`/`deviceLabel`/`computeLabel` computed locally from props). Keep the `COMPUTE_TYPE_OPTIONS` constant in this file. The `AlertDialog`s for download/upgrade confirm stay in `EnginesTab` (they need the shared binary-source selector).

`renderer/components/resources/engines/panels/FunasrPanel.tsx` is **self-contained** (lowest-risk): start from a copy of the current `FunasrEngineCard.tsx`, then:

- Remove the `EngineCardShell` wrapper — render the inner body directly in a `<div className="space-y-4">`.
- Remove the `isActive`/`onActivated` props and the **Set-active button** (current lines ~548–558) — activation now lives on the card.
- Remove the **model list block** (current lines ~619–633) and all model-row state/handlers (`modelStatus.models` rows, `modelProgress`, `downloadingModel`, `handleDownloadModel`, `handleCancelModel`, `handleDeleteModel`, the `MODEL_ORDER`/`renderModelRow`, and the `downloadProgress` `funasr:<id>` listener) — models now live in the Models tab (Task 7). Keep `loadModelStatus` only for `engineInstalled`/`ready`/version (used to toggle download vs uninstall UI).
- Keep: package download/uninstall buttons, version + check-update/upgrade row, the advanced ITN/threads block, the two `AlertDialog`s (download/upgrade confirm), and `sourceSelector`.
- Add a "go to models" link where the model list used to be.

Prop interface (self-contained):

```tsx
interface FunasrPanelProps {
  status?: import('../../../../../types/engine').EngineStatus;
  taskBusy: boolean;
  defaultSource: import('../../../../types/addon').DownloadSource;
  onRefreshStatuses: () => void | Promise<void>;
  onGoModels: () => void;
}
```

The "go to models" link (replaces the in-card model list, shown when the package is installed):

```tsx
{
  pkgInstalled && (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={onGoModels}
    >
      <Download className="h-3.5 w-3.5" />
      {t('engines.funasr.modelsTitle')}
    </Button>
  );
}
```

`renderer/components/resources/engines/panels/BaseRuntimePanel.tsx`: move the body of the existing `renderer/components/resources/BaseRuntimeCard.tsx` (its status/upgrade/check-update UI) into a panel. Keep `BaseRuntimeCard`'s data fetching/handlers inside this panel (it is self-contained). Prop interface: `{ taskBusy: boolean; defaultSource: DownloadSource }` (same as `BaseRuntimeCard` props).

- [ ] **Step 3: Create `EngineManageDrawer.tsx` (full code)**

```tsx
import React from 'react';
import { useTranslation } from 'next-i18next';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { TranscriptionEngine } from '../../../../types/engine';

type ManageTarget = TranscriptionEngine | 'base';

interface EngineManageDrawerProps {
  target: ManageTarget | null;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** 右侧引擎管理抽屉：承载某个引擎的全部配置面板。 */
const EngineManageDrawer: React.FC<EngineManageDrawerProps> = ({
  target,
  onOpenChange,
  title,
  description,
  children,
}) => {
  useTranslation('resources');
  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
};

export default EngineManageDrawer;
```

- [ ] **Step 4: Rewrite `EnginesTab.tsx` to grid + drawer**

Keep all existing state, refs, `refresh`, IPC listeners, and handlers in `EnginesTab.tsx`. Make these changes:

1. Add drawer state: `const [manageTarget, setManageTarget] = useState<TranscriptionEngine | 'base' | null>(null);`
2. Add lightweight funasr card state in `EnginesTab` (no handler lift — `FunasrPanel` stays self-contained). Add `const [funasrPkgInstalled, setFunasrPkgInstalled] = useState(false); const [funasrModelsReady, setFunasrModelsReady] = useState(false);` and in `refresh()` fetch funasr status once: `const fr = await window?.ipc?.invoke('getFunasrModelStatus'); if (fr?.success) { setFunasrPkgInstalled(!!fr.engineInstalled); setFunasrModelsReady(!!fr.ready); }`. These drive the funasr card badge + `canSetActive`. Also subscribe to `py-engine-download-progress` filtered to `engineId === 'funasr'` to call `refresh()` on `completed`, so the card badge updates after a package download done inside the drawer.
3. Replace the `renderEngineCard(...)` calls and `<FunasrEngineCard .../>` with a card grid of `EngineWorkbenchCard`, one per engine (`builtin`, `fasterWhisper`, `funasr`, `localCli`) plus a base-runtime card.
4. For FunASR, set `canSetActive` based on **package installed** (M4): `canSetActive={funasrPkgInstalled}` and the badge shows `engines.funasr.needsModels` when `pkgInstalled && !modelsReady`. The set-active call uses the existing `handleSelectEngine('funasr')` (backend already only gates on package).
5. Wire `onManage={() => setManageTarget(engine)}` and render a single `EngineManageDrawer` whose content switches on `manageTarget`:

```tsx
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <EngineWorkbenchCard
            isActive={currentEngine === 'builtin'}
            icon={Box}
            name={t('engines.builtin.name')}
            recommended
            recommendedLabel={t('engines.tags.recommended')}
            chips={[
              t('engines.tags.macRecommended'),
              t('engines.tags.noDownload'),
              t('engines.tags.gpu'),
            ]}
            desc={t('engines.builtin.desc')}
            scenario={t('engines.builtin.scenario')}
            badge={renderEngineBadge('builtin')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('builtin')}
            onManage={() => setManageTarget('builtin')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'fasterWhisper'}
            icon={Zap}
            name={t('engines.fasterWhisper.name')}
            chips={[
              t('engines.tags.faster'),
              t('engines.tags.accurateTimestamps'),
              ...(fasterInstalled
                ? []
                : [t('engines.tags.needsDownload', { size: PY_ENGINE_SIZE })]),
            ]}
            desc={t('engines.fasterWhisper.desc')}
            scenario={t('engines.fasterWhisper.scenario')}
            badge={renderEngineBadge('fasterWhisper')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('fasterWhisper')}
            onManage={() => setManageTarget('fasterWhisper')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'funasr'}
            icon={Languages}
            name={t('engines.funasr.name')}
            recommended
            recommendedLabel={t('engines.tags.chineseRecommended')}
            chips={[
              t('engines.tags.multilang'),
              t('engines.tags.cpuFriendly'),
              ...(funasrPkgInstalled
                ? []
                : [t('engines.tags.needsDownload', { size: FUNASR_ENGINE_SIZE })]),
            ]}
            desc={t('engines.funasr.desc')}
            scenario={t('engines.funasr.scenario')}
            badge={renderEngineBadge('funasr')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive={funasrPkgInstalled}
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('funasr')}
            onManage={() => setManageTarget('funasr')}
          />
          <EngineWorkbenchCard
            isActive={currentEngine === 'localCli'}
            icon={Terminal}
            name={t('engines.localCli.name')}
            chips={[t('engines.tags.advanced'), t('engines.tags.byoModel')]}
            desc={t('engines.localCli.desc')}
            scenario={t('engines.localCli.scenario')}
            badge={renderEngineBadge('localCli')}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive
            setActiveDisabled={taskBusy}
            onSetActive={() => handleSelectEngine('localCli')}
            onManage={() => setManageTarget('localCli')}
          />
          {/* Base runtime card: reuse EngineWorkbenchCard with no set-active */}
          <EngineWorkbenchCard
            isActive={false}
            icon={Cpu}
            name={t('engines.base.name')}
            chips={[]}
            desc={t('engines.base.desc')}
            badge={<span />}
            activeLabel={t('engines.active')}
            setActiveLabel={t('engines.setActive')}
            manageLabel={t('overview.manage')}
            canSetActive={false}
            onSetActive={() => {}}
            onManage={() => setManageTarget('base')}
          />
        </div>

        <EngineManageDrawer
          target={manageTarget}
          onOpenChange={(open) => !open && setManageTarget(null)}
          title={drawerTitle(manageTarget)}
        >
          {manageTarget === 'fasterWhisper' && <FasterWhisperPanel {...fasterWhisperPanelProps} />}
          {manageTarget === 'funasr' && (
            <FunasrPanel
              status={engineStatuses.funasr}
              taskBusy={taskBusy}
              defaultSource={binarySource}
              onRefreshStatuses={refresh}
              onGoModels={() => router.push(`/${locale}/resources?tab=models`)}
            />
          )}
          {manageTarget === 'localCli' && (
            <LocalCliPanel
              whisperCommand={whisperCommand}
              onCommandChange={setWhisperCommand}
              onSave={handleSaveWhisperCommand}
            />
          )}
          {manageTarget === 'builtin' && (
            <BuiltinPanel onGoModels={() => router.push(`/${locale}/resources?tab=models`)} />
          )}
          {manageTarget === 'base' && (
            <BaseRuntimePanel taskBusy={taskBusy} defaultSource={binarySource} />
          )}
        </EngineManageDrawer>
```

`drawerTitle` and `fasterWhisperPanelProps` are defined in Step 7 below; `FunasrPanel` is self-contained (Step 2) so it needs no prop-assembly object. Keep the existing faster-whisper download/upgrade `AlertDialog`s and `renderBinarySourceSelector` in `EnginesTab` (they are triggered by the `FasterWhisperPanel` callbacks). The funasr `AlertDialog`s + source selector move **into** `FunasrPanel` (it owns its package lifecycle). Keep `renderEngineBadge` and extend it with the funasr case from Step 8.

6. Add imports at the top of `EnginesTab.tsx`:

```ts
import { useRouter } from 'next/router';
import EngineWorkbenchCard from '@/components/resources/engines/EngineWorkbenchCard';
import EngineManageDrawer from '@/components/resources/engines/EngineManageDrawer';
import FasterWhisperPanel from '@/components/resources/engines/panels/FasterWhisperPanel';
import FunasrPanel from '@/components/resources/engines/panels/FunasrPanel';
import LocalCliPanel from '@/components/resources/engines/panels/LocalCliPanel';
import BuiltinPanel from '@/components/resources/engines/panels/BuiltinPanel';
import BaseRuntimePanel from '@/components/resources/engines/panels/BaseRuntimePanel';
import { Languages } from 'lucide-react';
```

Add `const FUNASR_ENGINE_SIZE = '28MB';` near `PY_ENGINE_SIZE`. Add `const router = useRouter(); const { locale } = router.query;` inside the component.

7. Define the drawer title helper + faster-whisper panel prop object inside the component (before the `return`). All referenced state/handlers already exist in `EnginesTab`:

```tsx
const drawerTitle = (target: TranscriptionEngine | 'base' | null): string => {
  if (target === 'base') return t('engines.base.name');
  if (target === 'fasterWhisper') return t('engines.fasterWhisper.name');
  if (target === 'funasr') return t('engines.funasr.name');
  if (target === 'localCli') return t('engines.localCli.name');
  if (target === 'builtin') return t('engines.builtin.name');
  return '';
};

const fasterWhisperPanelProps = {
  status: fasterStatus,
  isDownloading,
  downloadProgress,
  showVerifying,
  fasterInstalled,
  fasterBroken,
  hasUpdate,
  checkingUpdate,
  taskBusy,
  device,
  computeType,
  deviceOptions,
  updateInfo,
  onDownload: () => {
    pendingActivateRef.current = true;
    setShowDownloadConfirm(true);
  },
  onRepair: () => {
    pendingActivateRef.current = false;
    setShowDownloadConfirm(true);
  },
  onUninstall: handleUninstall,
  onCheckUpdate: handleCheckUpdate,
  onUpgrade: () => setShowUpgradeConfirm(true),
  onDeviceChange: handleDeviceChange,
  onComputeTypeChange: handleComputeTypeChange,
};
```

8. Extend `renderEngineBadge` with a funasr case (mirrors the old `FunasrEngineCard` badge). Insert before the final `return readyBadge;`:

```tsx
if (engine === 'funasr') {
  if (funasrPkgInstalled && funasrModelsReady) return readyBadge;
  if (funasrPkgInstalled && !funasrModelsReady) {
    return (
      <Badge variant="outline" className="border-primary/40 text-primary">
        {t('engines.funasr.needsModels')}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0 text-muted-foreground">
      {t('engines.funasr.notInstalled')}
    </Badge>
  );
}
```

- [ ] **Step 5: Delete the obsolete `FunasrEngineCard.tsx`**

```bash
git rm renderer/components/resources/FunasrEngineCard.tsx
```

(Its model-list logic moved to `FunasrModelSection` in Task 7; its engine-package logic moved to `FunasrPanel` + `EnginesTab`.)

- [ ] **Step 6: Type-check + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run check:i18n`
Expected: pass (all new `t(...)` keys exist from Task 6; note `engines.base.name`/`desc` already exist).

- [ ] **Step 7: Manual smoke (`npm run dev`)**

- Engines tab shows a card grid; each card has status badge, chips, scenario, and Set-active / Manage.
- Manage opens a right drawer with that engine's config; download/upgrade/uninstall/device/compute/ITN/threads/command all work as before.
- FunASR: with only the engine package installed (no models), "Set as current" is enabled and switches; header badge shows "FunASR".

- [ ] **Step 8: Commit**

```bash
git add renderer/components/resources/EnginesTab.tsx renderer/components/resources/engines
git commit -m "feat(engines): workbench cards + manage drawer; funasr activates without models"
```

---

## Task 10: Final sweep + full verification

**Files:**

- Verify: `renderer/components/onboarding/OnboardingDialog.tsx`, `renderer/pages/[locale]/home.tsx`, `renderer/components/Layout.tsx`

- [ ] **Step 1: Verify OnboardingDialog engine handling**

Run: `rg -n "resolveEngine|getSelectableModelsForEngine|transcriptionEngine|funasr" renderer/components/onboarding/OnboardingDialog.tsx`
If it lists engine-specific labels/branches that exclude funasr, add a funasr case mirroring fasterWhisper. If it only calls `resolveEngine`/`getSelectableModelsForEngine` (engine-agnostic), no change needed — these are funasr-aware after Task 3.

- [ ] **Step 2: Confirm home banner + header are funasr-correct**

`home.tsx` uses `hasModelsForEngine(systemInfo, settings?.useLocalWhisper)` — already correct after Task 3. `Layout.tsx` badge uses `engineBadge.funasr` — correct after Task 6. No code change expected; verify by reading.

- [ ] **Step 3: Full verification suite**

Run: `npm run test:engines`
Expected: `engine unit tests: N passed, 0 failed`.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run check:i18n`
Expected: `✓ i18n check passed`.

- [ ] **Step 4: End-to-end manual smoke (`npm run dev`)**

1. Engine page: card grid one-screen; manage drawer per engine.
2. FunASR: install engine package only → can set as current; header shows FunASR.
3. Models tab with FunASR active: "Current engine" shows FunASR (not Local CLI); download SenseVoice + Paraformer + VAD; open-folder opens `models/funasr`.
4. Task page with FunASR active + VAD + ≥1 ASR installed: model dropdown lists only installed ASR models (no VAD); selecting Paraformer starts a task and produces an SRT (requires the republished funasr engine from Task 5).
5. Switch to Local CLI: tasks start without model-file validation.
6. Switch to faster-whisper / builtin: unchanged behavior.

- [ ] **Step 5: Commit any sweep fixes**

```bash
git add -A
git commit -m "chore(funasr): final engine-awareness sweep + verification"
```

---

## Self-Review Notes

- **Spec coverage:** Point 1 → Task 9; Point 2 → Tasks 1,5,7; Point 3 → Task 9 (set-active gate); Point 4 → Tasks 3,4 (+ localCli unchanged); Point 5 → Task 6 (engineBadge.funasr); Point 6 → Tasks 6,7 (EngineContextBar); Point 7 → Tasks 3,7; Point 8 → Tasks 2,3,8,10.
- **Type consistency:** `FunasrModelId` includes `paraformer-zh` everywhere (catalog, downloader via `FUNASR_MODELS`, status IPC iterates keys). `model_type` values `'sense_voice' | 'paraformer'` match between `funasrModelCatalog.FunasrModelType`, the adapter injection, and the sidecar `_build_recognizer`. `ISystemInfo.funasr*` fields match `EngineModelInfo` and `Models.tsx` props.
- **Verification commands:** `npm run test:engines`, `npx tsc --noEmit`, `npm run check:i18n`, manual smoke — all exist in this repo.
