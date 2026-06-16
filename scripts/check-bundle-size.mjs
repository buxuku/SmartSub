#!/usr/bin/env node
/**
 * 主安装包体积门禁：dist/ 下生成的安装包必须 ≤ LIMIT_MB。
 * 基座按平台内置后，主包仍需控制在约定上限内（设计目标 200MB）。
 * 退出码非 0 表示超限。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT_MB = Number(process.env.BUNDLE_LIMIT_MB || 200);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

if (!fs.existsSync(distDir)) {
  console.error('dist/ not found; run a build first (npm run build:local)');
  process.exit(1);
}

const exts = new Set(['.dmg', '.zip', '.exe', '.AppImage', '.appimage', '.deb']);
let failed = false;
let checked = 0;

for (const f of fs.readdirSync(distDir)) {
  if (!exts.has(path.extname(f))) continue;
  checked += 1;
  const mb = fs.statSync(path.join(distDir, f)).size / 1024 / 1024;
  const tag = mb <= LIMIT_MB ? 'OK ' : 'BIG';
  console.log(`[${tag}] ${f}: ${mb.toFixed(1)}MB (limit ${LIMIT_MB}MB)`);
  if (mb > LIMIT_MB) failed = true;
}

if (checked === 0) {
  console.error('No installer artifacts found in dist/ to check');
  process.exit(1);
}

process.exit(failed ? 1 : 0);
