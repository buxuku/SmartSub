# Global Network Proxy Implementation Plan (item 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional global HTTP/HTTPS proxy (modes `none` / `custom`) that transparently covers all main-process networking (engine/model downloads, version checks, and every translation provider) plus a "test connectivity" action, configured from a new Settings card.

**Architecture:** Use `global-agent` to patch Node's global http/https agents in the main process. Because every download uses bare `https.get` (headers only, no `agent`) and every translation provider uses bare `axios.post` (no `httpsAgent`), patching the global agent covers all of them with zero per-call changes. Proxy config lives in the existing `settings` store object; the existing `setSettings` IPC applies it live (`global-agent` reads its proxy config per request, so changes take effect without restart). A small pure function `resolveProxyEnv()` is unit-tested; bootstrap/connectivity are wired in and manually verified.

**Tech Stack:** Electron main process, `electron-store`, `global-agent`, Node `https`. UI: React + Tailwind in `renderer/pages/[locale]/settings.tsx`. Tests via `yarn test:engines`.

**Spec:** `docs/superpowers/specs/2026-06-14-ui-polish-and-infra-analysis-design.md` §4.2.

> **Deviation from spec (deliberate, DRY):** spec §4.2.4 listed `proxy:get-config` / `proxy:set-config` / `proxy:test`. The app already persists `settings` through `getSettings`/`setSettings`, so this plan stores the proxy fields there and hooks proxy-apply into `setSettings`, adding only a new `proxy:test` IPC. Same behavior, no duplicate source of truth.

---

## File Structure

- Modify: `package.json` — add `global-agent` dep + `@types/global-agent` dev dep.
- Modify: `main/helpers/store/types.ts` — add `proxyMode` / `proxyUrl` / `proxyNoProxy` to `settings`.
- Modify: `main/helpers/store/index.ts` — defaults (`proxyMode: 'none'`).
- Create: `main/helpers/network/proxyManager.ts` — `resolveProxyEnv` (pure), `bootstrapProxy`, `applyProxyFromSettings`, `testProxyConnectivity`.
- Create: `main/helpers/ipcNetworkHandlers.ts` — `setupNetworkHandlers()` registering `proxy:test`.
- Modify: `main/helpers/ipcStoreHandlers.ts` — call `applyProxyFromSettings()` inside `setSettings` when a proxy field changes.
- Modify: `main/background.ts` — bootstrap + apply proxy early; register network handlers.
- Modify: `scripts/test-engine-units.ts` — unit tests for `resolveProxyEnv`.
- Modify: `renderer/pages/[locale]/settings.tsx` — new "网络代理" card (mode radio, URL input, test button).
- Modify: `renderer/public/locales/zh/settings.json` + `renderer/public/locales/en/settings.json` — proxy i18n keys.

---

## Task 1: Add dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install global-agent + types**

Run: `yarn add global-agent && yarn add -D @types/global-agent`
Expected: `package.json` gains `"global-agent"` under dependencies and `"@types/global-agent"` under devDependencies; `yarn.lock` updates; exit 0.

- [ ] **Step 2: Verify install**

Run: `node -e "require('global-agent'); console.log('ok')"`
Expected: prints `ok` (module resolves).

- [ ] **Step 3: Commit**

```bash
git add package.json yarn.lock
git commit -m "build: add global-agent for global network proxy support"
```

---

## Task 2: Extend settings store with proxy fields

**Files:**

- Modify: `main/helpers/store/types.ts:23-49`
- Modify: `main/helpers/store/index.ts:15-37`

- [ ] **Step 1: Add proxy fields to the `settings` type**

In `main/helpers/store/types.ts`, inside the `settings:` object type, add after `fasterWhisperModelsPath?: string;` (currently `:48`):

```ts
    fasterWhisperModelsPath?: string;
    /** 全局网络代理模式（none=直连；custom=手动 URL） */
    proxyMode?: 'none' | 'custom';
    /** custom 模式的代理 URL，如 http://user:pass@host:port */
    proxyUrl?: string;
    /** 可选 NO_PROXY 列表（逗号分隔），默认 localhost,127.0.0.1 */
    proxyNoProxy?: string;
```

- [ ] **Step 2: Add default to the store**

In `main/helpers/store/index.ts`, inside `defaults.settings`, add after `fasterWhisperComputeType: 'auto',` (currently `:36`):

```ts
      fasterWhisperComputeType: 'auto',
      proxyMode: 'none' as const,
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors from the new fields).

- [ ] **Step 4: Commit**

```bash
git add main/helpers/store/types.ts main/helpers/store/index.ts
git commit -m "feat(settings): add proxy fields to settings store"
```

---

## Task 3: Proxy manager (pure mapping + bootstrap + apply + test) — TDD

**Files:**

- Create: `main/helpers/network/proxyManager.ts`
- Test: `scripts/test-engine-units.ts`

- [ ] **Step 1: Write the failing test for `resolveProxyEnv`**

In `scripts/test-engine-units.ts`, add this import near the other imports (after the `downloadSourceOrder` import, currently `:25-28`):

```ts
import { resolveProxyEnv } from '../main/helpers/network/proxyManager';
```

Then add these assertions before the final `console.log` summary line (currently `:165`):

```ts
// --- resolveProxyEnv ---
eq(
  resolveProxyEnv({ proxyMode: 'none' }),
  { httpProxy: '', noProxy: '' },
  'proxy: none -> empty',
);
eq(
  resolveProxyEnv({}),
  { httpProxy: '', noProxy: '' },
  'proxy: undefined mode -> empty',
);
eq(
  resolveProxyEnv({
    proxyMode: 'custom',
    proxyUrl: '  http://127.0.0.1:7890  ',
  }),
  { httpProxy: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1' },
  'proxy: custom trims url + default no_proxy',
);
eq(
  resolveProxyEnv({ proxyMode: 'custom', proxyUrl: '' }),
  { httpProxy: '', noProxy: '' },
  'proxy: custom without url -> empty (no proxy)',
);
eq(
  resolveProxyEnv({
    proxyMode: 'custom',
    proxyUrl: 'http://h:1',
    proxyNoProxy: 'localhost,example.com',
  }),
  { httpProxy: 'http://h:1', noProxy: 'localhost,example.com' },
  'proxy: custom passes through no_proxy',
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:engines`
Expected: FAIL — `tsc` errors with "Cannot find module '../main/helpers/network/proxyManager'" (file not created yet).

- [ ] **Step 3: Create `proxyManager.ts` with the implementation**

Create `main/helpers/network/proxyManager.ts`:

```ts
import * as https from 'https';
import { bootstrap } from 'global-agent';
import { store } from '../store';
import { logMessage } from '../storeManager';

export interface ProxySettings {
  proxyMode?: 'none' | 'custom';
  proxyUrl?: string;
  proxyNoProxy?: string;
}

export interface ProxyEnv {
  httpProxy: string;
  noProxy: string;
}

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1';

/**
 * 纯函数：把代理设置映射为 global-agent 需要的 {httpProxy, noProxy}。
 * none / 缺失 / custom 但无 URL → 全空（等于关闭代理）。
 */
export function resolveProxyEnv(settings: ProxySettings): ProxyEnv {
  const url = (settings?.proxyUrl || '').trim();
  if (settings?.proxyMode === 'custom' && url) {
    const noProxy = (settings.proxyNoProxy || DEFAULT_NO_PROXY).trim();
    return { httpProxy: url, noProxy };
  }
  return { httpProxy: '', noProxy: '' };
}

interface GlobalAgentConfig {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
}

function getGlobalAgent(): GlobalAgentConfig | undefined {
  return (global as unknown as { GLOBAL_AGENT?: GlobalAgentConfig })
    .GLOBAL_AGENT;
}

let bootstrapped = false;

/** 进程内只调用一次 global-agent bootstrap（幂等）。须在任何联网前执行。 */
export function bootstrapProxy(): void {
  if (bootstrapped) return;
  // 不通过 env 前缀自动注入，统一由 applyProxyFromSettings 显式写 global 配置
  bootstrap();
  bootstrapped = true;
}

/** 按当前 settings 写入 global-agent 运行时配置；空字符串=直连。改完即时生效。 */
export function applyProxyFromSettings(): void {
  const settings = store.get('settings') as ProxySettings | undefined;
  const { httpProxy, noProxy } = resolveProxyEnv(settings || {});

  // process.env 兜底（部分库读 env）；global-agent 运行时读 global.GLOBAL_AGENT
  process.env.GLOBAL_AGENT_HTTP_PROXY = httpProxy;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = httpProxy;
  process.env.GLOBAL_AGENT_NO_PROXY = noProxy;

  const ga = getGlobalAgent();
  if (ga) {
    ga.HTTP_PROXY = httpProxy;
    ga.HTTPS_PROXY = httpProxy;
    ga.NO_PROXY = noProxy;
  }

  logMessage(
    `proxy applied: ${httpProxy ? `custom ${httpProxy}` : 'none (direct)'}`,
    'info',
  );
}

export interface ProxyTestResult {
  ok: boolean;
  ms: number;
  status?: number;
  error?: string;
}

/** 经当前 global agent 向轻量端点发请求，回报连通性。 */
export function testProxyConnectivity(
  testUrl = 'https://www.gstatic.com/generate_204',
): Promise<ProxyTestResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = https.get(
      testUrl,
      { headers: { 'User-Agent': 'SmartSub-Electron' }, timeout: 8000 },
      (res) => {
        const ms = Date.now() - startedAt;
        res.resume(); // 释放 socket
        resolve({ ok: true, ms, status: res.statusCode });
      },
    );
    req.on('error', (err) => {
      resolve({
        ok: false,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error: 'timeout' });
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:engines`
Expected: PASS — output ends with `engine unit tests: N passed, 0 failed` (N includes the 5 new proxy assertions).

- [ ] **Step 5: Commit**

```bash
git add main/helpers/network/proxyManager.ts scripts/test-engine-units.ts
git commit -m "feat(network): add proxyManager (resolve/bootstrap/apply/test) with unit tests"
```

---

## Task 4: Wire proxy into startup + settings save + add test IPC

**Files:**

- Create: `main/helpers/ipcNetworkHandlers.ts`
- Modify: `main/helpers/ipcStoreHandlers.ts:69-86`
- Modify: `main/background.ts:36-37,112,169`

- [ ] **Step 1: Create the network IPC handler**

Create `main/helpers/ipcNetworkHandlers.ts`:

```ts
import { ipcMain } from 'electron';
import { testProxyConnectivity } from './network/proxyManager';

export function setupNetworkHandlers(): void {
  ipcMain.handle('proxy:test', async (_event, testUrl?: string) => {
    return testProxyConnectivity(testUrl);
  });
}
```

- [ ] **Step 2: Apply proxy live when settings change**

In `main/helpers/ipcStoreHandlers.ts`, add an import near the top (after the `shutdownPythonRuntime` import, currently `:11`):

```ts
import { applyProxyFromSettings } from './network/proxyManager';
```

Then, inside the existing `setSettings` handler (currently `:69-86`), after the `store.set('settings', ...)` line (currently `:71`), add a proxy-change check:

```ts
store.set('settings', { ...preSettings, ...settings });
if (
  settings?.proxyMode !== undefined ||
  settings?.proxyUrl !== undefined ||
  settings?.proxyNoProxy !== undefined
) {
  applyProxyFromSettings();
}
```

- [ ] **Step 3: Bootstrap + apply proxy early in startup**

In `main/background.ts`, add an import (after the `maybeAutoCheckPyEngineUpdate` import, currently `:37`):

```ts
import {
  bootstrapProxy,
  applyProxyFromSettings,
} from './helpers/network/proxyManager';
```

Then, in the async IIFE, immediately after `setupStoreHandlers();` (currently `:112`), add:

```ts
setupStoreHandlers();
// 代理须在任何联网（providers 初始化 / 下载 / 更新检测）前生效
bootstrapProxy();
applyProxyFromSettings();
```

- [ ] **Step 4: Register the network handlers**

In `main/background.ts`, add the import (after the engine handlers import block, near `:35`):

```ts
import { setupNetworkHandlers } from './helpers/ipcNetworkHandlers';
```

Then call it alongside the other handler setups, after `setupIpcHandlers(mainWindow);` (currently `:169`):

```ts
setupIpcHandlers(mainWindow);
setupNetworkHandlers();
```

- [ ] **Step 5: Typecheck the main process**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors). `bootstrap` typed via `@types/global-agent`.

- [ ] **Step 6: Commit**

```bash
git add main/helpers/ipcNetworkHandlers.ts main/helpers/ipcStoreHandlers.ts main/background.ts
git commit -m "feat(network): bootstrap proxy at startup, apply on settings change, add proxy:test IPC"
```

---

## Task 5: Settings UI card + i18n

**Files:**

- Modify: `renderer/public/locales/zh/settings.json`
- Modify: `renderer/public/locales/en/settings.json`
- Modify: `renderer/pages/[locale]/settings.tsx`

- [ ] **Step 1: Add proxy i18n keys (zh)**

In `renderer/public/locales/zh/settings.json`, add these keys (place them next to the other top-level settings keys, e.g. right after `"settingsDesc"`; exact sibling location doesn't matter as long as they are top-level in the `settings` namespace):

```json
  "proxyTitle": "网络代理",
  "proxyDesc": "为下载、更新检测和翻译服务统一设置网络代理",
  "proxyMode": "代理模式",
  "proxyModeNone": "不使用",
  "proxyModeCustom": "自定义",
  "proxyUrl": "代理地址",
  "proxyUrlPlaceholder": "http://127.0.0.1:7890",
  "proxyNoProxy": "不代理的地址（可选）",
  "proxyNoProxyPlaceholder": "localhost,127.0.0.1",
  "proxyTest": "测试连通性",
  "proxyTesting": "测试中...",
  "proxyTestOk": "连接成功（{{ms}} ms）",
  "proxyTestFail": "连接失败：{{error}}",
  "proxySaved": "代理设置已保存",
```

- [ ] **Step 2: Add the same keys (en)**

In `renderer/public/locales/en/settings.json`:

```json
  "proxyTitle": "Network Proxy",
  "proxyDesc": "Route downloads, update checks and translation services through a proxy",
  "proxyMode": "Proxy mode",
  "proxyModeNone": "None",
  "proxyModeCustom": "Custom",
  "proxyUrl": "Proxy URL",
  "proxyUrlPlaceholder": "http://127.0.0.1:7890",
  "proxyNoProxy": "No-proxy hosts (optional)",
  "proxyNoProxyPlaceholder": "localhost,127.0.0.1",
  "proxyTest": "Test connection",
  "proxyTesting": "Testing...",
  "proxyTestOk": "Connected ({{ms}} ms)",
  "proxyTestFail": "Failed: {{error}}",
  "proxySaved": "Proxy settings saved",
```

- [ ] **Step 3: Add the `Globe` icon import in settings.tsx**

In `renderer/pages/[locale]/settings.tsx`, add `Globe,` to the `lucide-react` import block (currently `:16-33`), e.g. after `Github,`:

```tsx
  Github,
  Globe,
```

- [ ] **Step 4: Add proxy state + handlers**

In `renderer/pages/[locale]/settings.tsx`, add state near the other `useState`s (after `const [advancedOpen, setAdvancedOpen] = useState(false);`, currently `:133`):

```tsx
const [proxyMode, setProxyMode] = useState<'none' | 'custom'>('none');
const [proxyUrl, setProxyUrl] = useState('');
const [proxyNoProxy, setProxyNoProxy] = useState('');
const [proxyTesting, setProxyTesting] = useState(false);
```

In the `loadSettings` effect, after `setVADSamplesOverlap(...)` (currently `:155`), hydrate the proxy state:

```tsx
setVADSamplesOverlap(settings.vadSamplesOverlap ?? 0.1);
setProxyMode(settings.proxyMode === 'custom' ? 'custom' : 'none');
setProxyUrl(settings.proxyUrl || '');
setProxyNoProxy(settings.proxyNoProxy || '');
```

Then add handlers (place near `handleVADChange`, e.g. after `applyVadPreset`/`isPresetActive`, before `const [exportDialogOpen...`, currently `:305`):

```tsx
const saveProxy = async (
  patch: Partial<{
    proxyMode: 'none' | 'custom';
    proxyUrl: string;
    proxyNoProxy: string;
  }>,
) => {
  try {
    await window?.ipc?.invoke('setSettings', patch);
    toast.success(t('proxySaved'));
  } catch {
    toast.error(t('saveFailed'));
  }
};

const handleProxyModeChange = (mode: 'none' | 'custom') => {
  setProxyMode(mode);
  void saveProxy({ proxyMode: mode });
};

const handleProxyUrlBlur = () => {
  void saveProxy({ proxyUrl, proxyNoProxy });
};

const handleProxyTest = async () => {
  setProxyTesting(true);
  try {
    // 先持久化当前输入，确保测试用的是最新代理
    await window?.ipc?.invoke('setSettings', {
      proxyMode,
      proxyUrl,
      proxyNoProxy,
    });
    const result = await window?.ipc?.invoke('proxy:test');
    if (result?.ok) {
      toast.success(t('proxyTestOk', { ms: result.ms }));
    } else {
      toast.error(t('proxyTestFail', { error: result?.error || 'unknown' }));
    }
  } catch (e) {
    toast.error(
      t('proxyTestFail', { error: e instanceof Error ? e.message : 'error' }),
    );
  } finally {
    setProxyTesting(false);
  }
};
```

- [ ] **Step 5: Render the proxy card**

In `renderer/pages/[locale]/settings.tsx`, insert this `Card` right after the system-settings `Card` closes (`</Card>` currently `:462`) and before the VAD card (`<Card>` currently `:464`):

```tsx
<Card>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <IconChip icon={Globe} />
      {t('proxyTitle')}
    </CardTitle>
    <p className="text-sm text-muted-foreground pt-1">{t('proxyDesc')}</p>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="flex items-center justify-between">
      <span>{t('proxyMode')}</span>
      <Select
        value={proxyMode}
        onValueChange={(v) => handleProxyModeChange(v as 'none' | 'custom')}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('proxyModeNone')}</SelectItem>
          <SelectItem value="custom">{t('proxyModeCustom')}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    {proxyMode === 'custom' && (
      <>
        <div className="space-y-2">
          <span>{t('proxyUrl')}</span>
          <Input
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            onBlur={handleProxyUrlBlur}
            placeholder={t('proxyUrlPlaceholder')}
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <span>{t('proxyNoProxy')}</span>
          <Input
            value={proxyNoProxy}
            onChange={(e) => setProxyNoProxy(e.target.value)}
            onBlur={handleProxyUrlBlur}
            placeholder={t('proxyNoProxyPlaceholder')}
            className="font-mono text-sm"
          />
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleProxyTest}
            disabled={proxyTesting}
          >
            <Activity className="h-4 w-4" />
            {proxyTesting ? t('proxyTesting') : t('proxyTest')}
          </Button>
        </div>
      </>
    )}
  </CardContent>
</Card>
```

(`Select`, `Input`, `Button`, `Activity`, `Card*`, `IconChip` are all already imported in this file.)

- [ ] **Step 6: i18n parity + typecheck**

Run: `yarn check:i18n`
Expected: exits 0 (proxy keys present in both zh and en).
Run: `npx tsc --noEmit -p renderer/tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/public/locales/zh/settings.json renderer/public/locales/en/settings.json "renderer/pages/[locale]/settings.tsx"
git commit -m "feat(settings): add network proxy card (none/custom + connectivity test)"
```

---

## Task 6: Whole-plan verification

- [ ] **Step 1: Unit tests**

Run: `yarn test:engines`
Expected: `... passed, 0 failed`.

- [ ] **Step 2: Build**

Run: `yarn build`
Expected: no new TypeScript errors.

- [ ] **Step 3: Manual proxy verification**

Start a local proxy (e.g. an HTTP proxy on `127.0.0.1:7890`). In the app:

1. Settings → 网络代理 → mode `自定义` → URL `http://127.0.0.1:7890` → blur → toast "代理设置已保存".
2. Click 测试连通性 → toast "连接成功 (… ms)" (and the proxy's access log shows the `generate_204` request).
3. Trigger a download (Engines → faster-whisper) and a translation: both appear in the proxy log.
4. Switch mode back to `不使用` → downloads/translation go direct (no proxy log entries).
5. Set an invalid URL (`http://127.0.0.1:1`) → 测试连通性 reports failure; switching to `不使用` restores connectivity.

- [ ] **Step 4: Format + commit any formatting**

Run: `yarn format`

```bash
git add -A
git commit -m "style: prettier formatting for proxy support"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §4.2.2 settings fields → Task 2; §4.2.3 proxyManager (bootstrap/apply/test) + early wiring → Tasks 3-4; §4.2.4 IPC + settings card + i18n → Tasks 4-5 (get/set reuse documented as a deliberate deviation); §4.2.5 boundaries respected (no electron-updater/system/SOCKS); §4.2.6 deps + tests → Tasks 1, 3, 6.
- **No placeholders:** all code is concrete, including the full `proxyManager.ts` and the card JSX.
- **Type consistency:** `resolveProxyEnv(ProxySettings): ProxyEnv` signature is identical in the implementation (Task 3 Step 3) and the test (Task 3 Step 1). `proxyMode: 'none' | 'custom'` matches between `store/types.ts` (Task 2), `proxyManager` (Task 3), and the renderer state (Task 5). IPC channel `proxy:test` matches between handler (Task 4 Step 1) and renderer call (Task 5 Step 4).
