#!/usr/bin/env node
/**
 * 构建期拉取 whisper.cpp 原生 addon 到 extraResources/addons/。
 *
 * addon.node 由 buxuku/whisper.cpp 的 builder 分支（.github/workflows/builder.yml）按
 * 多平台编译并发布到 `latest` Release（GitCode 镜像 buxuku1/whisper.node）。这里按 host
 * 平台/架构取对应产物，落到 extraResources/addons/，与 .github/workflows/release.yml 里
 * 打包前 “Download addon / Prepare addon” 的步骤等价——让开发者一条命令就能拿到当前开发
 * 环境依赖的 addon，而不必本地从源码编译。
 *
 * 产物对应（与 release.yml 矩阵一致）：
 *   darwin arm64 -> addon-macos-arm64.node        => addon.node
 *                   addon-macos-arm64-coreml.node  => addon.coreml.node
 *   darwin x64   -> addon-macos-x64.node           => addon.node
 *   win32  x64   -> addon-windows-x64.node         => addon.node
 *                   addon-windows-vulkan.node.gz   => addon.vulkan.node (gunzip)
 *   linux  x64   -> addon-linux-x64.node           => addon.node
 *                   addon-linux-vulkan.node.gz     => addon.vulkan.node (gunzip)
 *
 * 用法：
 *   node scripts/fetch-whisper-addon.mjs                 # host 平台/架构
 *   node scripts/fetch-whisper-addon.mjs --arch=x64      # 指定架构（交叉打包/CI 矩阵）
 *   node scripts/fetch-whisper-addon.mjs --source=gitcode --out=/tmp/addons
 *
 * 镜像源（默认 github，自动按 github -> gh-proxy -> gitcode 回退；--source / 环境变量
 * ADDON_DOWNLOAD_SOURCE 可改首选源）。下载 / 重签逻辑与 fetch-sherpa-native.mjs 共用
 * scripts/lib/native-download.mjs。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadWithFallback,
  gunzip,
  resignMacNodes,
} from './lib/native-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 与 main/helpers/addonDownloader.ts 的 ADDON_REPO_SLUGS / 下载端点默认值保持一致。
const RELEASE_TAG = 'latest';
const REPO_GITHUB = 'buxuku/whisper.cpp';
const REPO_GITCODE = 'buxuku1/whisper.node';
const GITHUB_BASE = 'https://github.com';
const GHPROXY_PREFIX = 'https://gh-proxy.com';
const GITCODE_BASE = 'https://gitcode.com';

// 单文件至少应有的字节数：真实 addon 均为数 MB，过小说明拿到的是 404/HTML 占位。
const MIN_PLAUSIBLE_BYTES = 100 * 1024;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

/** 某下载源下单个 asset 的直链。 */
function assetUrl(source, asset) {
  const github = `${GITHUB_BASE}/${REPO_GITHUB}/releases/download/${RELEASE_TAG}/${asset}`;
  if (source === 'gitcode') {
    return `${GITCODE_BASE}/${REPO_GITCODE}/releases/download/${RELEASE_TAG}/${asset}`;
  }
  if (source === 'ghproxy') {
    return `${GHPROXY_PREFIX}/${github}`;
  }
  return github;
}

/** 首选源 + 其余源回退（去重）。 */
function buildUrls(asset, preferred) {
  const order = {
    github: ['github', 'ghproxy', 'gitcode'],
    ghproxy: ['ghproxy', 'github', 'gitcode'],
    gitcode: ['gitcode', 'ghproxy', 'github'],
  }[preferred] || ['github', 'ghproxy', 'gitcode'];
  return order.map((s) => assetUrl(s, asset));
}

/** host 平台/架构 -> 需要下载并落地的产物列表（与 release.yml 矩阵一致）。 */
function resolveTargets(platform, arch) {
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return [
        { asset: 'addon-macos-arm64.node', out: 'addon.node' },
        { asset: 'addon-macos-arm64-coreml.node', out: 'addon.coreml.node' },
      ];
    }
    if (arch === 'x64') {
      return [{ asset: 'addon-macos-x64.node', out: 'addon.node' }];
    }
    throw new Error(`Unsupported macOS arch: ${arch}`);
  }
  if (platform === 'win32') {
    // Windows 仅发布 x64（arm64 主机走 x64 仿真）。
    return [
      { asset: 'addon-windows-x64.node', out: 'addon.node' },
      {
        asset: 'addon-windows-vulkan.node.gz',
        out: 'addon.vulkan.node',
        gunzip: true,
      },
    ];
  }
  if (platform === 'linux') {
    if (arch !== 'x64') {
      throw new Error(
        `Only linux-x64 prebuilt addon is published (got ${arch}); build it locally instead`,
      );
    }
    return [
      { asset: 'addon-linux-x64.node', out: 'addon.node' },
      {
        asset: 'addon-linux-vulkan.node.gz',
        out: 'addon.vulkan.node',
        gunzip: true,
      },
    ];
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function assertPlausible(file, label) {
  const size = fs.statSync(file).size;
  if (size < MIN_PLAUSIBLE_BYTES) {
    const head = fs.readFileSync(file).subarray(0, 80).toString('utf8');
    throw new Error(
      `${label} looks invalid (${size} bytes), aborting. First bytes: ${head}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = process.platform;
  const arch = args.arch || process.env.BUILD_ARCH || process.arch;
  const source = args.source || process.env.ADDON_DOWNLOAD_SOURCE || 'github';
  const outDir = args.out
    ? path.resolve(args.out)
    : path.join(root, 'extraResources', 'addons');

  const targets = resolveTargets(platform, arch);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(
    `Fetching whisper addon for ${platform}-${arch} (source=${source}) -> ${outDir}`,
  );

  for (const t of targets) {
    const tmp = path.join(os.tmpdir(), `smartsub-${t.asset}`);
    console.log(`Fetching ${t.asset} ...`);
    const hit = await downloadWithFallback(buildUrls(t.asset, source), tmp);
    assertPlausible(tmp, t.asset);

    const destPath = path.join(outDir, t.out);
    if (t.gunzip) {
      await gunzip(tmp, destPath);
    } else {
      fs.copyFileSync(tmp, destPath);
    }
    fs.rmSync(tmp, { force: true });
    assertPlausible(destPath, t.out);
    console.log(`  ${t.out}  <-  ${hit}`);
  }

  resignMacNodes(outDir);

  console.log(`whisper addon ready at ${outDir} (${platform}-${arch})`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
