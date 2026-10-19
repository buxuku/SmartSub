// TEMPORARY (issue #547). 与 SmartSub 的 main/helpers/addonLoader.ts tryLoadCandidate 一致：
//   process.dlopen(module, path)（不带 flags，即 Node 默认的 RTLD_LAZY），加载后要求 exports.whisper 是函数。
//
// 用法：node dlopen-check.js <addon.node> [--smartsub-env] [--now] [--preload <lib>...]
//   --smartsub-env  先照 setupLibraryPath() 做：把 addon 所在目录加进【运行中进程】的 LD_LIBRARY_PATH
//   --now           addon 本身用 RTLD_NOW（应用用的是默认的 RTLD_LAZY；NOW 更严格，会立刻解析全部符号，仅供参考）
//   --preload       先用绝对路径依次 dlopen 这些库（glibc 会按 SONAME 复用已加载的库来满足 DT_NEEDED）
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const file = path.resolve(args[0]);
const smartsubEnv = args.includes('--smartsub-env');
const now = args.includes('--now');
const preloadAt = args.indexOf('--preload');
const preload = preloadAt >= 0 ? args.slice(preloadAt + 1) : [];

if (smartsubEnv) {
  const dir = path.dirname(file);
  const cur = process.env.LD_LIBRARY_PATH || '';
  if (!cur.includes(dir)) process.env.LD_LIBRARY_PATH = `${dir}:${cur}`;
}

try {
  for (const lib of preload) {
    process.dlopen({ exports: {} }, path.resolve(lib), os.constants.dlopen.RTLD_NOW | os.constants.dlopen.RTLD_GLOBAL);
  }
  const mod = { exports: { whisper: null } };
  if (now) process.dlopen(mod, file, os.constants.dlopen.RTLD_NOW);
  else process.dlopen(mod, file);
  if (typeof mod.exports.whisper !== 'function') {
    throw new Error('Addon loaded but exports no whisper()');
  }
  console.log('DLOPEN_OK whisper=' + typeof mod.exports.whisper);
} catch (e) {
  console.log('DLOPEN_FAIL ' + String((e && e.message) || e).replace(/\s+/g, ' '));
  process.exitCode = 3;
}
