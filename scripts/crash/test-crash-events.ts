import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENTS_RETENTION_MS,
  appendCrashEvent,
  createPathRedactor,
  pruneCrashEvents,
  readCrashEvents,
  rotatedFileOf,
  type CrashEvent,
} from '../../main/helpers/crash/crashEvents';
import { assert, finish, test } from './testkit';

const DAY = 24 * 60 * 60 * 1000;

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-crash-events-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function event(ts: number, extra: Partial<CrashEvent> = {}): CrashEvent {
  return { ts, source: 'child-process-gone', ...extra };
}

async function main() {
  await test('追加与读取往返；目录不存在时自动创建', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'logs', 'crash-events.jsonl');
      assert.equal(
        appendCrashEvent(file, event(1000, { reason: 'crashed' })),
        true,
      );
      assert.equal(
        appendCrashEvent(file, event(2000, { reason: 'oom' })),
        true,
      );
      const events = readCrashEvents(file);
      assert.deepEqual(
        events.map((e) => e.reason),
        ['crashed', 'oom'],
      );
      // 每条事件占一行
      assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
    }));

  await test('读取：sinceTs 与 limit；文件不存在返回空数组', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      assert.deepEqual(readCrashEvents(file), []);
      for (const ts of [10, 20, 30, 40]) appendCrashEvent(file, event(ts));
      assert.deepEqual(
        readCrashEvents(file, { sinceTs: 30 }).map((e) => e.ts),
        [30, 40],
      );
      assert.deepEqual(
        readCrashEvents(file, { limit: 2 }).map((e) => e.ts),
        [30, 40],
      );
    }));

  await test('超过大小上限时轮转；轮转文件只保留一份，读取按时间合并', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      const maxBytes = 120;
      for (let i = 1; i <= 5; i++) {
        appendCrashEvent(
          file,
          event(i * 1000, { detail: 'x'.repeat(60) }),
          maxBytes,
        );
      }
      assert.ok(fs.existsSync(rotatedFileOf(file)), '应当产生轮转文件');
      assert.equal(path.basename(rotatedFileOf(file)), 'crash-events.1.jsonl');
      const events = readCrashEvents(file);
      // 有界：最老的已被覆盖，最新的一定在
      assert.ok(events.length <= 3);
      assert.equal(events[events.length - 1].ts, 5000);
      const times = events.map((e) => e.ts);
      assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b),
      );
    }));

  await test('半行与坏行被跳过，不影响其余事件', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      appendCrashEvent(file, event(1000));
      fs.appendFileSync(file, '{"ts":2000,"source":"child-pro');
      fs.appendFileSync(file, '\nnot json at all\n{"ts":"bad","source":1}\n');
      appendCrashEvent(file, event(3000));
      assert.deepEqual(
        readCrashEvents(file).map((e) => e.ts),
        [1000, 3000],
      );
    }));

  await test('写入失败返回 false 而不是抛错', () =>
    withTempDir((dir) => {
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'a regular file');
      // 父路径是个普通文件，mkdir 与 append 都会失败
      assert.equal(
        appendCrashEvent(
          path.join(blocker, 'sub', 'crash-events.jsonl'),
          event(1),
        ),
        false,
      );
    }));

  await test('清理：超过 30 天的事件被删除，保留期内的保留', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      const now = Date.UTC(2026, 9, 9);
      appendCrashEvent(file, event(now - 31 * DAY, { reason: 'old' }));
      appendCrashEvent(file, event(now - 29 * DAY, { reason: 'recent' }));
      appendCrashEvent(file, event(now - 1 * DAY, { reason: 'fresh' }));
      pruneCrashEvents(file, now);
      assert.deepEqual(
        readCrashEvents(file).map((e) => e.reason),
        ['recent', 'fresh'],
      );
      assert.equal(EVENTS_RETENTION_MS, 30 * DAY);
    }));

  await test('清理：全部过期则删除文件；没有可清理内容时不改动文件', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      const now = Date.UTC(2026, 9, 9);
      appendCrashEvent(file, event(now - 40 * DAY));
      pruneCrashEvents(file, now);
      assert.equal(fs.existsSync(file), false);

      appendCrashEvent(file, event(now - DAY));
      const before = fs.readFileSync(file, 'utf8');
      const mtime = fs.statSync(file).mtimeMs;
      pruneCrashEvents(file, now);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(fs.statSync(file).mtimeMs, mtime);
      // 不会遗留临时文件
      assert.deepEqual(fs.readdirSync(dir), ['crash-events.jsonl']);
    }));

  await test('清理同样作用于轮转文件', () =>
    withTempDir((dir) => {
      const file = path.join(dir, 'crash-events.jsonl');
      const now = Date.UTC(2026, 9, 9);
      fs.writeFileSync(
        rotatedFileOf(file),
        JSON.stringify(event(now - 50 * DAY)) + '\n',
      );
      appendCrashEvent(file, event(now - DAY));
      pruneCrashEvents(file, now);
      assert.equal(fs.existsSync(rotatedFileOf(file)), false);
      assert.equal(readCrashEvents(file).length, 1);
    }));

  await test('路径脱敏：POSIX、Windows（大小写、正反斜杠、JSON 转义）都替换成 ~', () => {
    const redact = createPathRedactor([
      '/Users/alice',
      'C:\\Users\\Alice',
      'D:\\data\\SmartSub\\',
    ]);
    assert.equal(
      redact('open /Users/alice/Library/x.node failed'),
      'open ~/Library/x.node failed',
    );
    assert.equal(
      redact('load C:\\Users\\Alice\\AppData\\a.node'),
      'load ~\\AppData\\a.node',
    );
    assert.equal(redact('c:\\users\\alice\\x'), '~\\x');
    assert.equal(redact('C:/Users/Alice/x'), '~/x');
    assert.equal(
      redact('{"path":"C:\\\\Users\\\\Alice\\\\x"}'),
      '{"path":"~\\\\x"}',
    );
    assert.equal(redact('D:\\data\\SmartSub\\logs'), '~\\logs');
  });

  await test('路径脱敏：太短的前缀不处理；更长的前缀优先，且空值被忽略', () => {
    const none = createPathRedactor(['/', 'C:', undefined, '']);
    assert.equal(none('/usr/lib and C:\\Windows'), '/usr/lib and C:\\Windows');
    // userData 在家目录之内：长前缀先替换，结果仍然只有一个 ~
    const nested = createPathRedactor([
      '/Users/alice',
      '/Users/alice/Library/App',
    ]);
    assert.equal(nested('/Users/alice/Library/App/logs'), '~/logs');
    assert.equal(nested('/Users/alice/other'), '~/other');
  });

  finish('crashEvents');
}

main();
