/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SYNC_CANVAS_GUARD } from '../jassub/syncCanvasGuard';

// scripts/check-jassub-worker-guard.mjs 在 `yarn build` 之后确认守卫还在 JASSUB Worker 的构建产物里
// （规则一旦不再命中，构建不会报错，单测也看不出来）。这里用假的 chunks 目录把它的几种结论都跑一遍，
// 并盯住它和守卫模块、e2e 脚本之间靠字符串字面量对齐的那几处。

const ROOT = path.resolve(__dirname, '../../..');
const CHECK_SCRIPT = path.join(ROOT, 'scripts/check-jassub-worker-guard.mjs');
const E2E_SCRIPT = path.join(ROOT, 'scripts/e2e/compose-sync-canvas.mjs');
const GUARD_KEY = Symbol.keyFor(SYNC_CANVAS_GUARD)!;

// 每个用例要起一个 node 进程，机器忙的时候 5 秒不够。
jest.setTimeout(30000);

const dirs: string[] = [];
function chunksDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jassub-guard-check-'));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), source);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function check(dir: string) {
  const run = spawnSync(process.execPath, [CHECK_SCRIPT, '--dir', dir], {
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// 压缩后的守卫模块里，键就是一个字符串字面量。
const guardModule = `{42961:function(){"use strict";let t=Symbol.for("${GUARD_KEY}")}}`;

describe('scripts/check-jassub-worker-guard.mjs', () => {
  it('passes when the worker chunk carries the guard', () => {
    const run = check(
      chunksDir({
        'jassub-worker.abc123.js': `!function(){var c=${guardModule}}();`,
        '4292.def456.js': 'self.desynchronized=!0;',
      }),
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('jassub-worker.abc123.js');
  });

  it('passes when the guard landed in another chunk instead of the entry chunk', () => {
    const run = check(
      chunksDir({
        'jassub-worker.abc123.js': '!function(){/* runtime only */}();',
        '4292.def456.js': `var m=${guardModule};`,
      }),
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('4292.def456.js');
  });

  it('fails when no chunk carries the guard (the pre-loader rule stopped matching)', () => {
    const run = check(
      chunksDir({
        'jassub-worker.abc123.js': '!function(){/* runtime only */}();',
        '4292.def456.js': 'self.desynchronized=!0;',
      }),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(GUARD_KEY);
    expect(run.stderr).toContain('renderer/next.config.js');
  });

  it('fails when there is no jassub-worker chunk at all', () => {
    const run = check(chunksDir({ '4292.def456.js': `var m=${guardModule};` }));

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('jassub-worker');
  });

  it('fails, and says to build first, when the chunks directory does not exist', () => {
    const run = check(path.join(os.tmpdir(), 'jassub-guard-check-missing-dir'));

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('yarn build');
  });

  it('fails when a chunk still carries the e2e recorder hook left by an interrupted run', () => {
    const run = check(
      chunksDir({
        'jassub-worker.abc123.js': `/*smartsub-e2e-getContext-recorder*/;(()=>{})();!function(){var c=${guardModule}}();`,
      }),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('jassub-worker.abc123.js');
    expect(run.stderr).toContain('yarn build');
  });

  it('only looks at .js files', () => {
    const run = check(
      chunksDir({
        'jassub-worker.abc123.js': '!function(){}();',
        'jassub-worker.abc123.js.map': `{"note":"${GUARD_KEY}"}`,
      }),
    );

    expect(run.status).toBe(1);
  });

  it('rejects --dir without a value', () => {
    const run = spawnSync(process.execPath, [CHECK_SCRIPT, '--dir'], {
      encoding: 'utf8',
    });

    expect(run.status).toBe(2);
  });
});

describe('literals shared between the guard, the check and the e2e', () => {
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const literal = (source: string, name: string) =>
    new RegExp(`const ${name} =\\s*'([^']+)'`).exec(source)?.[1];

  it('uses the same guard key as the guard module', () => {
    expect(literal(read(CHECK_SCRIPT), 'GUARD_KEY')).toBe(GUARD_KEY);
    // e2e 在 Worker 里按这个键去找守卫的标记。
    expect(read(E2E_SCRIPT)).toContain(`Symbol.for('${GUARD_KEY}')`);
  });

  it('uses the same e2e hook mark as the e2e script', () => {
    const mark = literal(read(CHECK_SCRIPT), 'E2E_HOOK_MARK');

    expect(mark).toBeTruthy();
    expect(read(E2E_SCRIPT)).toContain(`'/*${mark}*/'`);
  });
});
