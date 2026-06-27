/**
 * 构建期原生依赖下载共享工具。
 *
 * fetch-sherpa-native.mjs 与 fetch-whisper-addon.mjs 都要从 GitHub / GitCode Release
 * 拉文件、按需校验、（macOS）改写 @rpath 并 ad-hoc 重签。这里把这几件事抽出来共用，
 * 避免两份脚本各拷一遍下载/重签逻辑。纯 Node 内置模块，无第三方依赖。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const USER_AGENT = 'SmartSub-Build';
const REQUEST_TIMEOUT_MS = 60000;

function pickProtocol(url) {
  return new URL(url).protocol === 'http:' ? http : https;
}

/** 下载单个 URL 到 dest，自动跟随重定向；4xx/5xx 抛错。 */
export function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = pickProtocol(url).get(
      url,
      { headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

/** 依次尝试一组镜像 URL，任一成功即返回命中的 URL；全部失败抛最后一个错误。 */
export async function downloadWithFallback(urls, dest, log = console.warn) {
  let lastError;
  for (const url of urls) {
    try {
      await download(url, dest);
      return url;
    } catch (error) {
      lastError = error;
      log(`download failed (${url}): ${error.message || error}`);
    }
  }
  throw lastError || new Error('All download sources failed');
}

/** 拉取文本（如 .sha256 校验文件），自动跟随重定向。 */
export function fetchText(url) {
  return new Promise((resolve, reject) => {
    pickProtocol(url)
      .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          fetchText(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toLowerCase();
}

/** gunzip srcPath -> destPath。 */
export function gunzip(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(srcPath);
    const write = fs.createWriteStream(destPath);
    read
      .pipe(zlib.createGunzip())
      .pipe(write)
      .on('finish', resolve)
      .on('error', reject);
  });
}

/**
 * macOS：把 .node/.dylib 的 @rpath 依赖改写为 @loader_path（同目录解析）并 ad-hoc 重签。
 * 静态链接产物（如 whisper addon）没有 @rpath 依赖，此时仅做 ad-hoc 重签，便于 dev 直接
 * dlopen；electron-builder 打包时会用正式签名覆盖。非 macOS 直接跳过。
 */
export function resignMacNodes(dir) {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.node') || f.endsWith('.dylib'));
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const otool = execFileSync('otool', ['-L', full]).toString();
      for (const line of otool.split('\n')) {
        const m = line.trim().match(/^@rpath\/(\S+)\s/);
        if (m) {
          execFileSync('install_name_tool', [
            '-change',
            `@rpath/${m[1]}`,
            `@loader_path/${m[1]}`,
            full,
          ]);
        }
      }
    } catch (e) {
      console.warn(`otool/install_name_tool skipped for ${f}: ${e}`);
    }
  }
  for (const f of files) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', path.join(dir, f)]);
    } catch (e) {
      console.warn(`ad-hoc codesign skipped for ${f}: ${e}`);
    }
  }
}
