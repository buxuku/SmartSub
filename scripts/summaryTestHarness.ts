/**
 * test:summary 共用的计数器。test-summary.ts 与 test-summary-cap.ts 写同一对数字，
 * 最后只打一行合计。
 */
export let passed = 0;
export let failed = 0;

export function ok(value: unknown, name: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`x ${name}`);
  }
}

export function equal<T>(actual: T, expected: T, name: string): void {
  const success = JSON.stringify(actual) === JSON.stringify(expected);
  ok(success, name);
  if (!success) {
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

export function reportSummaryTests(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
