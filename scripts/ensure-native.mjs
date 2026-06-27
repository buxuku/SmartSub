#!/usr/bin/env node
/**
 * dev / install 前确保原生依赖就绪。
 *
 * whisper addon（extraResources/addons/addon.node）与 sherpa-onnx 原生库都改为按需 fetch、
 * 不入库（见 .gitignore）。新克隆仓库的开发者第一次 `yarn install` / `yarn dev` 时，这里检测
 * 到缺失就自动跑对应的 fetch 脚本，省去手动 `yarn native:fetch` 的步骤。
 *
 * CI 上跳过：release.yml 有显式的 addon / sherpa fetch 步骤，避免在 `yarn install` 阶段引入
 * 额外网络下载与失败面（满足“不影响 CI”的要求）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.CI) {
  console.log('[ensure-native] CI detected, skipping (handled by explicit CI steps).');
  process.exit(0);
}

/** 与 getSherpaPlatformKey() 一致：darwin-<arch> / win-x64 / linux-<arch>。 */
function sherpaPlatformKey() {
  const arch = process.arch === 'ia32' ? 'ia32' : process.arch;
  if (process.platform === 'win32') return `win-${arch === 'arm64' ? 'x64' : arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

function run(script) {
  execFileSync('node', [path.join('scripts', script)], {
    cwd: root,
    stdio: 'inherit',
  });
}

const addonPresent = fs.existsSync(
  path.join(root, 'extraResources', 'addons', 'addon.node'),
);
const sherpaPresent = fs.existsSync(
  path.join(
    root,
    'extraResources',
    'sherpa',
    'native',
    sherpaPlatformKey(),
    'sherpa-onnx.node',
  ),
);

try {
  if (!addonPresent) {
    console.log('[ensure-native] addon.node missing -> fetching whisper addon ...');
    run('fetch-whisper-addon.mjs');
  }
  if (!sherpaPresent) {
    console.log('[ensure-native] sherpa native missing -> fetching sherpa libs ...');
    run('fetch-sherpa-native.mjs');
  }
  if (addonPresent && sherpaPresent) {
    console.log('[ensure-native] native deps present, nothing to do.');
  }
} catch (e) {
  // 不阻断 install/dev：联网失败时给出明确提示，后续流程自行处理缺失。
  console.warn(
    `[ensure-native] auto-fetch failed: ${e?.message || e}\n` +
      '  Run "yarn native:fetch" manually once network is available.',
  );
}
