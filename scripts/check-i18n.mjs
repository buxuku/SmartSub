#!/usr/bin/env node
/**
 * i18n 质量门禁：
 * 1. zh/en namespace 文件集合与 key 集合必须完全对等
 * 2. 源码不允许新增 `t('key') || '兜底文案'` 模式（key 已保证存在，兜底只会掩盖缺键）
 * 退出码非 0 表示存在问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'renderer/public/locales');
const srcDirs = ['renderer/components', 'renderer/pages', 'renderer/hooks'].map(
  (d) => path.join(root, d),
);

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✗ ${msg}`);
};

// ---------- 1. key 对等 ----------
const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatten(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );

const listJson = (loc) =>
  fs
    .readdirSync(path.join(localesDir, loc))
    .filter((f) => f.endsWith('.json'))
    .sort();

const zhFiles = listJson('zh');
const enFiles = listJson('en');

for (const f of zhFiles.filter((f) => !enFiles.includes(f))) {
  fail(`namespace 仅存在于 zh: ${f}`);
}
for (const f of enFiles.filter((f) => !zhFiles.includes(f))) {
  fail(`namespace 仅存在于 en: ${f}`);
}

for (const f of zhFiles.filter((f) => enFiles.includes(f))) {
  const zh = new Set(
    flatten(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh', f), 'utf8'))),
  );
  const en = new Set(
    flatten(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', f), 'utf8'))),
  );
  for (const k of zh) {
    if (!en.has(k)) fail(`${f} 缺 en key: ${k}`);
  }
  for (const k of en) {
    if (!zh.has(k)) fail(`${f} 缺 zh key: ${k}`);
  }
}

// ---------- 2. 禁止 t() || '兜底' ----------
const fallbackPattern =
  /\bt\(\s*'(?:[^'\\]|\\.)*'(?:\s*,\s*\{[^{}]*\})?\s*\)\s*\|\|\s*(?:'|"|`)/;

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });

for (const dir of srcDirs) {
  for (const file of walk(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (fallbackPattern.test(line)) {
        fail(
          `i18n 兜底模式（请补 key 而非兜底）: ${path.relative(root, file)}:${i + 1}`,
        );
      }
    });
  }
}

if (failed) {
  process.exit(1);
}
console.log('✓ i18n check passed: zh/en key parity OK, no fallback patterns');
