#!/usr/bin/env node
/**
 * 构建后检查：JASSUB Worker 的构建产物里必须带着 Windows 黑屏守卫
 * （根因见 renderer/lib/jassub/syncCanvasGuard.ts）。
 *
 * 守卫靠 renderer/next.config.js 里的 webpack pre-loader 规则注入到 JASSUB 的 Worker 入口。
 * 规则匹配不到（Next / webpack 改了 Worker 的打包方式、上游挪了入口……）时构建不会报错，
 * 而单测只看 node_modules 里的原始文件，发现不了——守卫悄悄没了，Windows 黑屏就会回来。
 * 所以在 `yarn build` 之后看一眼产物：守卫里 `Symbol.for('smartsub.syncCanvasGuard')` 的键是
 * 字符串字面量，压缩器不会改写它；守卫模块只会经由这条注入规则进入构建，所以它出现就说明规则命中了。
 *
 * 这里只检查「在不在」。「先于渲染器执行、交给原生的属性里没有 desynchronized: true」
 * 要跑真实应用才看得到，见 scripts/e2e/compose-sync-canvas.mjs。
 *
 * 用法：yarn check:jassub-guard [--dir <chunks 目录>]（默认 app/_next/static/chunks，只看生产构建）。
 * 退出码非 0 表示存在问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 与 renderer/lib/jassub/syncCanvasGuard.ts 里 Symbol.for(...) 的键保持一致（有单测盯着）。
const GUARD_KEY = 'smartsub.syncCanvasGuard';
// scripts/e2e/compose-sync-canvas.mjs 临时塞进 Worker chunk 的记录钩子的标记，被中断时可能残留（有单测盯着）。
const E2E_HOOK_MARK = 'smartsub-e2e-getContext-recorder';
// 生产构建里 JASSUB Worker 的入口 chunk，名字来自 `new Worker(url, { name: 'jassub-worker' })`。
const WORKER_CHUNK = /^jassub-worker\..+\.js$/;

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
if (dirFlag !== -1 && !args[dirFlag + 1]) {
  console.error('✗ --dir 后面需要跟一个 chunks 目录');
  process.exit(2);
}
const chunksDir =
  dirFlag === -1
    ? path.join(root, 'app/_next/static/chunks')
    : path.resolve(args[dirFlag + 1]);

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✗ ${msg}`);
};

if (!fs.existsSync(chunksDir) || !fs.statSync(chunksDir).isDirectory()) {
  console.error(`✗ 找不到构建产物目录 ${chunksDir}，请先 yarn build`);
  process.exit(1);
}

// 只看目录下的顶层 chunk：Worker 入口和它加载的 chunk 都在这一层。
const sources = new Map(
  fs
    .readdirSync(chunksDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => [name, fs.readFileSync(path.join(chunksDir, name), 'utf8')]),
);
const names = [...sources.keys()];
const containing = (needle) =>
  names.filter((name) => sources.get(name).includes(needle));

const workerChunks = names.filter((name) => WORKER_CHUNK.test(name));
const carriers = containing(GUARD_KEY);

if (workerChunks.length === 0) {
  fail(
    `${chunksDir} 里没有 jassub-worker.*.js：JASSUB 的 Worker 没有被打成独立 chunk，` +
      '或它的命名变了。守卫和 e2e 都按这个名字找 Worker，请同步检查 renderer/next.config.js 的规则、' +
      'scripts/e2e/compose-sync-canvas.mjs 和本脚本',
  );
} else if (carriers.length === 0) {
  fail(
    `构建产物里没有 Windows 黑屏守卫（所有 chunk 里都找不到 "${GUARD_KEY}"）。` +
      'renderer/next.config.js 里注入守卫的 pre-loader 规则没有命中 JASSUB 的 Worker 入口，' +
      '合成页的预览在 Windows 上会重新出现整块黑屏。先检查 jassub 的 Worker 入口路径和 Next / webpack 对 Worker 的处理是否变了',
  );
}

const hooked = containing(E2E_HOOK_MARK);
if (hooked.length > 0) {
  fail(
    `${hooked.join('、')} 里还带着 e2e 的记录钩子（上一次 compose-sync-canvas e2e 被中断？），请重新 yarn build`,
  );
}

if (failed) process.exit(1);
console.log(
  `✓ JASSUB Worker 守卫检查通过：${carriers.join('、')} 里带着守卫（Worker 入口 chunk：${workerChunks.join('、')}）`,
);
