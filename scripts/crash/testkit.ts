/**
 * 崩溃诊断单测的最小工具：沿用仓库里 tsx 脚本的写法（node:assert/strict + 逐条打印），
 * 失败时汇总并以非零退出码结束，便于 CI 判定。
 */
import assert from 'node:assert/strict';

export { assert };

let passed = 0;
const failures: string[] = [];

export async function test(
  name: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

export function finish(label: string): void {
  if (failures.length > 0) {
    console.error(`\n${label}: ${failures.length} 项失败`);
    for (const name of failures) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log(`\n${label}: ${passed} 项通过`);
}
