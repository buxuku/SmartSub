/**
 * 摘要 usage 累加单测。由 test-summary.ts 调用，计数写进 summaryTestHarness。
 */
import { accumulateSummaryUsage } from '../main/helpers/episodeSummaryCore';
import { equal } from './summaryTestHarness';

function testFirstCallOnly(): void {
  equal(
    accumulateSummaryUsage({ input_tokens: 11, output_tokens: 4 }, undefined),
    { input_tokens: 11, output_tokens: 4 },
    'first call tokens stay when there is no retry',
  );
}

function testRetrySumsBothSides(): void {
  equal(
    accumulateSummaryUsage(
      { input_tokens: 11, output_tokens: 4 },
      { promptTokens: 7, completionTokens: 3 },
    ),
    { input_tokens: 18, output_tokens: 7 },
    'retry adds prompt tokens to input and completion tokens to output',
  );
}

function testOneSideUndefined(): void {
  equal(
    accumulateSummaryUsage(
      { output_tokens: 4 },
      { promptTokens: 7 },
    ),
    { input_tokens: 7, output_tokens: 4 },
    'a missing side keeps the count that was reported',
  );
  equal(
    accumulateSummaryUsage({ input_tokens: 0, output_tokens: 0 }, undefined),
    { input_tokens: 0, output_tokens: 0 },
    'a reported zero stays zero when the other call is absent',
  );
}

function testBothUndefined(): void {
  const usage = accumulateSummaryUsage({}, {});
  equal(
    usage.input_tokens,
    undefined,
    'input stays undefined when neither call reported prompt tokens',
  );
  equal(
    usage.output_tokens,
    undefined,
    'output stays undefined when neither call reported completion tokens',
  );
}

export function runSummaryUsageTests(): void {
  testFirstCallOnly();
  testRetrySumsBothSides();
  testOneSideUndefined();
  testBothUndefined();
}
