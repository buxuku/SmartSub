/// <reference path="./test-globals.d.ts" />
import {
  isStructuredOutputUnsupportedError,
  resolveStructuredOutputMode,
  runWithStructuredOutputFallback,
  type StructuredOutputMode,
} from '../main/service/structuredOutputFallback';
import { TaskCancelledError } from '../main/helpers/taskContext';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

async function run(): Promise<void> {
  // resolveStructuredOutputMode：structuredOutput 优先 → useJsonMode 兼容 → 默认值
  eq(
    resolveStructuredOutputMode({ structuredOutput: 'json_schema' }),
    'json_schema',
    'resolve: explicit structuredOutput wins',
  );
  eq(
    resolveStructuredOutputMode({ useJsonMode: false }),
    'disabled',
    'resolve: legacy useJsonMode=false → disabled',
  );
  eq(
    resolveStructuredOutputMode({}, 'json_schema'),
    'json_schema',
    'resolve: falls back to caller default',
  );
  eq(
    resolveStructuredOutputMode({ structuredOutput: 'bogus' }, 'json_object'),
    'json_object',
    'resolve: invalid stored value ignored',
  );

  // isStructuredOutputUnsupportedError：需同时命中主题词与否定词
  eq(
    isStructuredOutputUnsupportedError(
      new Error('response_format is unsupported by this model'),
    ),
    true,
    'unsupported-error: matches response_format + unsupported',
  );
  eq(
    isStructuredOutputUnsupportedError(new Error('401 Unauthorized')),
    false,
    'unsupported-error: auth error not matched',
  );

  // 回退链：json_schema → json_object → disabled，逐级降级最终成功
  {
    const tried: StructuredOutputMode[] = [];
    const result = await runWithStructuredOutputFallback({
      startMode: 'json_schema',
      shouldFallback: () => true,
      attempt: async (mode) => {
        tried.push(mode);
        if (mode !== 'disabled') throw new Error(`fail at ${mode}`);
        return 'ok';
      },
    });
    eq(result, 'ok', 'chain: degrades to disabled and succeeds');
    eq(
      tried,
      ['json_schema', 'json_object', 'disabled'],
      'chain: tries modes in priority order',
    );
  }

  // shouldFallback 返回 false 时立即抛出，不再降级
  {
    const tried: StructuredOutputMode[] = [];
    let error: unknown;
    try {
      await runWithStructuredOutputFallback({
        startMode: 'json_object',
        shouldFallback: (_from, err) => isStructuredOutputUnsupportedError(err),
        attempt: async (mode) => {
          tried.push(mode);
          throw new Error('500 internal server error');
        },
      });
    } catch (e) {
      error = e;
    }
    eq(
      (error as Error)?.message,
      '500 internal server error',
      'gate: unrelated error rethrown',
    );
    eq(tried, ['json_object'], 'gate: no fallback for unrelated error');
  }

  // 严格模式：首个错误直接抛出（测试自动探测用）
  {
    const tried: StructuredOutputMode[] = [];
    let error: unknown;
    try {
      await runWithStructuredOutputFallback({
        startMode: 'json_schema',
        strict: true,
        shouldFallback: () => true,
        attempt: async (mode) => {
          tried.push(mode);
          throw new Error('response_format is unsupported');
        },
      });
    } catch (e) {
      error = e;
    }
    eq(!!error, true, 'strict: throws first error');
    eq(tried, ['json_schema'], 'strict: no degradation');
  }

  // 任务取消不参与降级
  {
    const tried: StructuredOutputMode[] = [];
    let error: unknown;
    try {
      await runWithStructuredOutputFallback({
        startMode: 'json_schema',
        shouldFallback: () => true,
        attempt: async (mode) => {
          tried.push(mode);
          throw new TaskCancelledError();
        },
      });
    } catch (e) {
      error = e;
    }
    eq(error instanceof TaskCancelledError, true, 'cancel: rethrown as-is');
    eq(tried, ['json_schema'], 'cancel: no fallback after cancellation');
  }

  // 起始模式为 disabled 时链上只有它自己
  {
    const tried: StructuredOutputMode[] = [];
    let error: unknown;
    try {
      await runWithStructuredOutputFallback({
        startMode: 'disabled',
        shouldFallback: () => true,
        attempt: async (mode) => {
          tried.push(mode);
          throw new Error('boom');
        },
      });
    } catch (e) {
      error = e;
    }
    eq((error as Error)?.message, 'boom', 'tail: disabled failure rethrown');
    eq(tried, ['disabled'], 'tail: no further modes after disabled');
  }

  console.log(
    `\nstructured-output-fallback: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) process.exit(1);
}

void run();
