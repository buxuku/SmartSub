'use strict';
/**
 * 在纯 Node 里直接 require 仓库里的 .ts 源码（只转译，不做类型检查）。
 * 验证脚本要跑的是应用里真正的实现（暂存、音频输入适配），而不是它的拷贝；
 * 被加载的模块不能依赖 electron（nativeSafePath.ts、whisperAudioInput.ts 都满足）。
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..', '..');

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = (module, filename) =>
    module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
}

/** 按仓库根目录的相对路径加载一个 .ts 模块。 */
function requireRepoTs(relativePath) {
  return require(path.join(repoRoot, relativePath));
}

module.exports = { requireRepoTs };
