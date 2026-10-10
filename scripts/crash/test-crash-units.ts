/**
 * 崩溃诊断单测的统一入口（yarn test:crash）。
 *
 * 逐个运行本目录下的 test-*.ts，每个套件是独立进程：输出不交错，一个套件失败不会
 * 吞掉其余套件的结果。新增套件只要按 test-*.ts 命名即可，无需改这里或 package.json。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = __dirname;
const self = path.basename(__filename);
const suites = fs
  .readdirSync(dir)
  .filter((name) => /^test-.+\.ts$/.test(name) && name !== self)
  .sort();

if (suites.length === 0) {
  console.error('没有找到任何测试套件');
  process.exit(1);
}

const tsxCli = require.resolve('tsx/cli');
const failed: string[] = [];

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [tsxCli, path.join(dir, suite)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.error(`\n失败的套件：${failed.join('、')}`);
  process.exit(1);
}
console.log(`\n全部 ${suites.length} 个套件通过`);
