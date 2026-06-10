/**
 * 把 Python 引擎冻结产物暂存到 extraResources/py-engine/,
 * 供 electron-builder 按现有 extraResources 约定打进安装包。
 *
 * 产物缺失时仅告警并保证目标目录存在(打出的包不含 Python 引擎,
 * 应用内回退 userData 运行时安装路径),不阻塞主应用打包。
 *
 * 用法:node scripts/stage-py-engine.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'python-engine', 'dist', 'smartsub-engine');
const target = path.join(root, 'extraResources', 'py-engine');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
// 占位文件保证目录始终存在(electron-builder 的 extraResources 不容忍缺目录)
fs.writeFileSync(path.join(target, '.gitkeep'), '');

if (!fs.existsSync(source)) {
  console.warn(
    `[stage-py-engine] WARNING: ${source} not found, app will be packaged WITHOUT the python engine.`,
  );
  console.warn(
    '[stage-py-engine] run "npm run engine:build" first (or download a prebuilt engine) to bundle it.',
  );
  process.exit(0);
}

fs.cpSync(source, target, { recursive: true });
const binName =
  process.platform === 'win32' ? 'smartsub-engine.exe' : 'smartsub-engine';
const staged = path.join(target, binName);
if (!fs.existsSync(staged)) {
  console.error(
    `[stage-py-engine] staged dir is missing executable: ${staged}`,
  );
  process.exit(1);
}
console.log(`[stage-py-engine] staged engine -> ${target}`);
