import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DUMP_MAX_BYTES,
  DUMP_MAX_FILES,
  listDumpFiles,
  pruneDumpFiles,
} from '../../main/helpers/crash/crashDumps';
import { assert, finish, test } from './testkit';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-crash-dumps-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个转储（可带同名 .meta），mtime 以“距今秒数”指定，越小越新。 */
function makeDump(
  dir: string,
  rel: string,
  size: number,
  ageSeconds: number,
  withMeta = false,
): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  if (withMeta) fs.writeFileSync(file.replace(/\.dmp$/, '.meta'), 'meta');
  return file;
}

async function main() {
  await test('默认策略：最多 5 个、总量 150 MB', () => {
    assert.equal(DUMP_MAX_FILES, 5);
    assert.equal(DUMP_MAX_BYTES, 150 * 1024 * 1024);
  });

  await test('递归列出 .dmp，最新的在前；忽略其他文件；目录不存在返回空数组', () =>
    withTempDir((dir) => {
      assert.deepEqual(listDumpFiles(path.join(dir, 'missing')), []);
      makeDump(dir, 'reports/old.dmp', 10, 300);
      makeDump(dir, 'reports/new.dmp', 10, 10);
      makeDump(dir, 'pending/mid.DMP', 10, 100);
      fs.writeFileSync(path.join(dir, 'settings.dat'), 'x');
      fs.writeFileSync(path.join(dir, 'metadata'), 'x');
      fs.writeFileSync(path.join(dir, 'pending', 'mid.meta'), 'x');
      assert.deepEqual(
        listDumpFiles(dir).map((d) => path.basename(d.file)),
        ['new.dmp', 'mid.DMP', 'old.dmp'],
      );
    }));

  await test('按数量清理：删最旧的，同名 .meta 一并删除，数据库文件不动', () =>
    withTempDir((dir) => {
      for (let i = 0; i < 8; i++) {
        makeDump(dir, `pending/d${i}.dmp`, 10, (8 - i) * 100, true);
      }
      fs.writeFileSync(path.join(dir, 'settings.dat'), 'x');
      fs.writeFileSync(path.join(dir, 'client_id'), 'x');
      const result = pruneDumpFiles(dir);
      assert.equal(result.kept, 5);
      assert.equal(result.removed.length, 3);
      const left = fs.readdirSync(path.join(dir, 'pending')).sort();
      // d3..d7 最新，保留；d0..d2 最旧，.dmp 与 .meta 都被删
      assert.deepEqual(left, [
        'd3.dmp',
        'd3.meta',
        'd4.dmp',
        'd4.meta',
        'd5.dmp',
        'd5.meta',
        'd6.dmp',
        'd6.meta',
        'd7.dmp',
        'd7.meta',
      ]);
      assert.ok(fs.existsSync(path.join(dir, 'settings.dat')));
      assert.ok(fs.existsSync(path.join(dir, 'client_id')));
    }));

  await test('按总量清理：从最新开始累加，超过上限的更旧文件被删', () =>
    withTempDir((dir) => {
      makeDump(dir, 'reports/a.dmp', 40, 10);
      makeDump(dir, 'reports/b.dmp', 40, 20);
      makeDump(dir, 'reports/c.dmp', 40, 30);
      const result = pruneDumpFiles(dir, { maxBytes: 100 });
      assert.equal(result.kept, 2);
      assert.deepEqual(
        listDumpFiles(dir).map((d) => path.basename(d.file)),
        ['a.dmp', 'b.dmp'],
      );
    }));

  await test('最新的一个永远保留，哪怕它自己超过总量上限', () =>
    withTempDir((dir) => {
      makeDump(dir, 'reports/big.dmp', 500, 10);
      makeDump(dir, 'reports/small.dmp', 5, 20);
      pruneDumpFiles(dir, { maxBytes: 100 });
      assert.deepEqual(
        listDumpFiles(dir).map((d) => path.basename(d.file)),
        ['big.dmp'],
      );
    }));

  await test('没有转储或目录不存在时不抛错', () =>
    withTempDir((dir) => {
      assert.deepEqual(pruneDumpFiles(path.join(dir, 'missing')), {
        kept: 0,
        removed: [],
      });
      assert.deepEqual(pruneDumpFiles(dir), { kept: 0, removed: [] });
    }));

  finish('crashDumps');
}

main();
