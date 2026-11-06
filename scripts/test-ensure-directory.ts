import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDirectorySync } from '../main/helpers/ensureDirectory';

function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-ensure-directory-'),
  );
  const volumeRoot = path.join(root, 'volume-root');
  fs.mkdirSync(volumeRoot);

  // Windows 对「已存在的卷根」（F:\）调用 mkdir 会抛 EPERM，即使带 recursive: true
  // （issue #590）。这里把 volumeRoot 当作卷根，让 fs.mkdirSync 对它抛同样的 EPERM；
  // denied 里追加的路径用来模拟「目录不存在、而且确实没有权限创建」。
  // 真实卷根上的验证见 .github/workflows/windows-driveroot.yml。
  const denied = new Set([volumeRoot]);
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (denied.has(path.resolve(String(target))))
      throw Object.assign(
        new Error(`EPERM: operation not permitted, mkdir '${target}'`),
        { code: 'EPERM', syscall: 'mkdir', path: String(target) },
      );
    return mkdir(target, options);
  }) as typeof fs.mkdirSync;

  try {
    // 前提：模拟确实生效，直接 mkdir 卷根会抛 EPERM。
    assert.throws(() => fs.mkdirSync(volumeRoot, { recursive: true }), {
      code: 'EPERM',
    });

    // 已存在的目录（卷根）不会调用 mkdir，内容原样保留。
    fs.writeFileSync(path.join(volumeRoot, 'keep.txt'), 'keep');
    ensureDirectorySync(volumeRoot);
    assert.equal(
      fs.readFileSync(path.join(volumeRoot, 'keep.txt'), 'utf8'),
      'keep',
    );

    // 不存在的目录（含多级父目录）照常创建，重复调用不报错。
    const nested = path.join(volumeRoot, 'a', 'b', 'c');
    ensureDirectorySync(nested);
    assert.ok(fs.statSync(nested).isDirectory());
    ensureDirectorySync(nested);

    // 路径被文件占用时仍然报错，且文件不被改动。
    const occupied = path.join(volumeRoot, 'occupied');
    fs.writeFileSync(occupied, 'file');
    assert.throws(
      () => ensureDirectorySync(occupied),
      (error: NodeJS.ErrnoException) =>
        error.code === 'EEXIST' || error.code === 'ENOTDIR',
    );
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'file');

    // 目录不存在且 mkdir 确实被拒绝时，错误照常抛出，不会被当成「已存在」吞掉。
    const blocked = path.join(volumeRoot, 'blocked');
    denied.add(blocked);
    assert.throws(() => ensureDirectorySync(blocked), { code: 'EPERM' });
    assert.equal(fs.existsSync(blocked), false);
  } finally {
    fs.mkdirSync = mkdir;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      checks:
        'existing directory (volume root whose mkdir fails with EPERM) left untouched, missing nested directories created, repeat calls, path occupied by a file still rejected, genuine mkdir failure on a missing directory still thrown',
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
