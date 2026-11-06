/**
 * Python sidecar 的 stdin 管道：引擎已经退出时再写入，EPIPE 不能变成主进程的未捕获异常。
 *
 * 写 stdin 的失败是异步的 'error' 事件，PythonRuntimeManager.write() 外面的 try/catch 接不住；
 * 没有 stdin 的 'error' 监听，这个事件就会以 “A JavaScript error occurred in the main process:
 * Error: write EPIPE” 的形式弹给用户。
 *
 * 用法：tsx scripts/test-python-engine-stdin.ts（失败时以非零退出码结束）
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  PythonEngineError,
  PythonRuntimeManager,
} from '../main/helpers/pythonRuntime/manager';

function busyWait(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 模拟一台很忙的机器：CreateProcess 很慢，调用方拿到子进程时它早就没了
  }
}

async function main() {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);

  const realSpawn = childProcess.spawn;
  (childProcess as { spawn: typeof realSpawn }).spawn = ((
    ...args: Parameters<typeof realSpawn>
  ) => {
    const child = realSpawn(...args);
    busyWait(250);
    return child;
  }) as typeof realSpawn;
  syncBuiltinESMExports();

  try {
    const manager = new PythonRuntimeManager(() => ({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }));
    await assert.rejects(
      manager.ensureStarted('faster-whisper'),
      (error: unknown) =>
        error instanceof PythonEngineError && error.code === 'engine_exited',
    );
    // 异步的 'error' 事件在下一轮才浮现
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      uncaught.map((error) => error.message),
      [],
      '写已退出引擎的 stdin 触发的 EPIPE 不能逃出 PythonRuntimeManager',
    );
    console.log(
      '✓ 引擎在第一次写入前就已退出：请求以 engine_exited 失败，没有未捕获的 EPIPE',
    );
    console.log('\nPython sidecar stdin: 1 项通过');
  } catch (error) {
    console.error(
      '✗ 引擎在第一次写入前就已退出：请求以 engine_exited 失败，没有未捕获的 EPIPE',
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    (childProcess as { spawn: typeof realSpawn }).spawn = realSpawn;
    syncBuiltinESMExports();
    process.off('uncaughtException', onUncaught);
  }
}

void main();
