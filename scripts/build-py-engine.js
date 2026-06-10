/**
 * 构建 Python 引擎冻结产物(跨平台封装 PyInstaller 调用)。
 *
 * 解析顺序:python-engine/.venv 内的 pyinstaller > PATH 上的 pyinstaller(CI)。
 * 产物:python-engine/dist/smartsub-engine/
 *
 * 用法:node scripts/build-py-engine.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const engineDir = path.join(__dirname, '..', 'python-engine');
const venvPyInstaller =
  process.platform === 'win32'
    ? path.join(engineDir, '.venv', 'Scripts', 'pyinstaller.exe')
    : path.join(engineDir, '.venv', 'bin', 'pyinstaller');

const pyinstaller = fs.existsSync(venvPyInstaller)
  ? venvPyInstaller
  : 'pyinstaller';

console.log(`[build-py-engine] using: ${pyinstaller}`);
const result = spawnSync(
  pyinstaller,
  ['--clean', '--noconfirm', 'smartsub-engine.spec'],
  { cwd: engineDir, stdio: 'inherit' },
);

if (result.error) {
  console.error(
    `[build-py-engine] failed to run pyinstaller: ${result.error.message}`,
  );
  console.error(
    '[build-py-engine] hint: cd python-engine && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller',
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
