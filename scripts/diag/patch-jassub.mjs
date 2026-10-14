#!/usr/bin/env node
/**
 * 给 node_modules/jassub 打「预览黑屏诊断」补丁（只用于诊断安装包的构建，不进正式版）。
 *
 * 为什么需要它：JASSUB 把 WebGL 上下文属性写死了（desynchronized:true、powerPreference:'high-performance'），
 * 渲染后端的选择也不可配置。上游 JASSUB#70 记录了「Windows 上 desynchronized:true 会导致黑屏」，
 * 我们要在用户机器上验证它是不是我们遇到的问题，就必须能在运行时改这几个参数。
 *
 * 补丁做三件事（默认行为与不打补丁完全一致，只有传了 diag 选项才会变）：
 *   1. 构造选项里多一个 `diag`，经 worker 参数转交给渲染器；
 *   2. worker 里装一个 OffscreenCanvas.prototype.getContext 拦截器：按 diag.desynchronized /
 *      diag.powerPreference 覆盖渲染器的请求，并记录渲染器「最终」传给 getContext 的属性；
 *      渲染后端（diag.renderer）在 worker 里选择；
 *   3. worker 创建上下文后，用 BroadcastChannel('smartsub-jassub-diag') 回报：真实的上下文属性、
 *      渲染器请求过的属性（requestedAttributes）、实际使用的渲染后端、GPU 型号、上下文丢失事件。
 *
 * 注意：不再改写渲染器源码里的 `desynchronized: true`。正式版用 webpack loader
 * （renderer/lib/jassub-sync-canvas-loader.js）在构建期把它改成「Windows 下为 false」，
 * 补丁要让这条修复保持为默认路径（诊断版因此就是被验证的那份代码），
 * 再叠加一个强制开关用来对照——所以覆盖放在 getContext 处，而不是改渲染器里的字面量。
 *
 * 用法：
 *   node scripts/diag/patch-jassub.mjs            # 打补丁（幂等）
 *   node scripts/diag/patch-jassub.mjs --check    # 只检查是否已打补丁
 *   node scripts/diag/patch-jassub.mjs --restore  # 还原
 *
 * 锚点任何一处找不到或不唯一就失败退出：宁可构建失败，也不要悄悄产出一个不带诊断能力的「诊断版」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'smartsub-diag-patch:1';
const SUPPORTED_VERSION = '2.5.6';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
// SMARTSUB_JASSUB_DIR 仅供单元测试把补丁打到临时副本上
const pkgDir = process.env.SMARTSUB_JASSUB_DIR
  ? path.resolve(process.env.SMARTSUB_JASSUB_DIR)
  : path.join(root, 'node_modules', 'jassub');
const backupDir = path.join(pkgDir, '.smartsub-diag-backup');

const DIAG = `(globalThis.__SMARTSUB_JASSUB_DIAG__ || {})`;

/**
 * getContext 拦截器（装在 worker 里，先于任何渲染器创建上下文）。
 *  - 诊断开关为默认值时，属性对象原样透传：默认路径 = 正式版（含 webpack loader 的 Windows 修复）。
 *  - 只覆盖渲染器本来就带了的键（2D 上下文没有 powerPreference，不凭空添加），且不改动原对象。
 *  - 只记录带属性对象的调用（JASSUB 的探测调用 getContext('webgl2') 不带属性）。
 * 两条 marker 注释让单元测试能把这一段单独取出来在沙箱里执行。
 */
const INTERPOSER = [
  `        // smartsub-diag:getContext-interposer:begin`,
  `        {`,
  `            const diag = globalThis.__SMARTSUB_JASSUB_DIAG__;`,
  `            const original = OffscreenCanvas.prototype.getContext;`,
  `            const requests = (globalThis.__SMARTSUB_JASSUB_REQUESTS__ = []);`,
  `            OffscreenCanvas.prototype.getContext = function (type, attrs) {`,
  `                let next = attrs;`,
  `                if (attrs && typeof attrs === 'object') {`,
  `                    const forceDesync = diag.desynchronized !== undefined && 'desynchronized' in attrs;`,
  `                    const forcePower = diag.powerPreference !== undefined && 'powerPreference' in attrs;`,
  `                    if (forceDesync || forcePower) {`,
  `                        next = { ...attrs };`,
  `                        if (forceDesync) next.desynchronized = diag.desynchronized;`,
  `                        if (forcePower) next.powerPreference = diag.powerPreference;`,
  `                    }`,
  `                    requests.push({ type, desynchronized: next.desynchronized, powerPreference: next.powerPreference });`,
  `                }`,
  `                return original.call(this, type, next);`,
  `            };`,
  `        }`,
  `        // smartsub-diag:getContext-interposer:end`,
].join('\n');

/** 每个文件一组 [旧文本, 新文本]；旧文本必须在文件里恰好出现一次。 */
const PATCHES = {
  'dist/jassub.js': [
    [
      `queryFonts: opts.queryFonts ?? 'local'\n`,
      `queryFonts: opts.queryFonts ?? 'local',\n            diag: opts.diag ?? null\n`,
    ],
  ],
  'dist/worker/worker.js': [
    [
      `this.debug = data.debug;\n`,
      [
        `this.debug = data.debug;`,
        `        globalThis.__SMARTSUB_JASSUB_DIAG__ = data.diag || {};`,
        INTERPOSER,
        ``,
      ].join('\n'),
    ],
    [
      `            if (testCanvas.getContext('webgl2')) {\n`,
      [
        `            const __smartsubDiag = ${DIAG};`,
        `            if (__smartsubDiag.renderer === '2d') {`,
        `                this._gpurender = new Canvas2DRenderer();`,
        `            }`,
        `            else if (__smartsubDiag.renderer === 'webgl1') {`,
        `                this._gpurender = new WebGL1Renderer();`,
        `            }`,
        `            else if (testCanvas.getContext('webgl2')) {`,
        ``,
      ].join('\n'),
    ],
    [
      `        this._gpurender.setCanvas(ctrl);\n`,
      [
        `        this._gpurender.setCanvas(ctrl);`,
        `        try {`,
        `            const gl = this._gpurender.gl;`,
        `            const info = gl && gl.getExtension ? gl.getExtension('WEBGL_debug_renderer_info') : null;`,
        `            const channel = new BroadcastChannel('smartsub-jassub-diag');`,
        `            channel.postMessage({`,
        `                ev: 'context',`,
        `                backend: !gl ? '2d' : (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1'),`,
        `                requested: ${DIAG},`,
        `                requestedAttributes: globalThis.__SMARTSUB_JASSUB_REQUESTS__ || [],`,
        `                attributes: gl && gl.getContextAttributes ? gl.getContextAttributes() : null,`,
        `                gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,`,
        `                vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null`,
        `            });`,
        `            for (const type of ['webglcontextlost', 'webglcontextrestored']) {`,
        `                ctrl.addEventListener(type, () => channel.postMessage({ ev: type }));`,
        `            }`,
        `        }`,
        `        catch { }`,
        ``,
      ].join('\n'),
    ],
  ],
};

function countOf(text, needle) {
  let count = 0;
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + needle.length)
  )
    count += 1;
  return count;
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    .version;
}

function isPatched(text) {
  return text.includes(MARKER);
}

function check() {
  const state = Object.keys(PATCHES).map((rel) => ({
    rel,
    patched: isPatched(fs.readFileSync(path.join(pkgDir, rel), 'utf8')),
  }));
  for (const { rel, patched } of state)
    console.log(`${patched ? 'patched ' : 'original'}  ${rel}`);
  return state.every((entry) => entry.patched);
}

function apply() {
  const version = readVersion();
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `jassub ${version} is installed, but this patch was written for ${SUPPORTED_VERSION}. ` +
        'Re-check the anchors in scripts/diag/patch-jassub.mjs before building a diagnostic version.',
    );
  }
  // 先全部验证再写盘：不会留下「打了一半」的状态
  const planned = [];
  for (const [rel, replacements] of Object.entries(PATCHES)) {
    const file = path.join(pkgDir, rel);
    const original = fs.readFileSync(file, 'utf8');
    if (isPatched(original)) {
      console.log(`skip (already patched)  ${rel}`);
      continue;
    }
    let next = original;
    for (const [from, to] of replacements) {
      const count = countOf(next, from);
      if (count !== 1) {
        throw new Error(
          `${rel}: expected exactly 1 anchor, found ${count}:\n${JSON.stringify(from)}`,
        );
      }
      next = next.replace(from, () => to);
    }
    planned.push({ rel, file, original, next: `/* ${MARKER} */\n${next}` });
  }
  fs.mkdirSync(backupDir, { recursive: true });
  for (const { rel, file, original, next } of planned) {
    const backup = path.join(backupDir, rel.replaceAll('/', '__'));
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
    fs.writeFileSync(file, next);
    console.log(`patched  ${rel}`);
  }
}

function restore() {
  let restored = 0;
  for (const rel of Object.keys(PATCHES)) {
    const backup = path.join(backupDir, rel.replaceAll('/', '__'));
    if (!fs.existsSync(backup)) continue;
    fs.writeFileSync(path.join(pkgDir, rel), fs.readFileSync(backup, 'utf8'));
    fs.rmSync(backup);
    restored += 1;
    console.log(`restored  ${rel}`);
  }
  if (restored === 0) console.log('nothing to restore');
  if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length === 0)
    fs.rmdirSync(backupDir);
}

try {
  if (process.argv.includes('--restore')) restore();
  else if (process.argv.includes('--check')) process.exit(check() ? 0 : 1);
  else {
    apply();
    if (!check()) throw new Error('patch verification failed');
  }
} catch (error) {
  console.error(
    `patch-jassub: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
