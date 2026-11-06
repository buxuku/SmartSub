/**
 * 原生代码（whisper / ggml）崩溃相关的进程环境。纯函数，不碰 electron。
 *
 * GGML_NO_BACKTRACE：上游 ggml 在 GGML_ABORT / 断言失败时，POSIX 下会 fork 出 gdb 或 lldb
 * 去打印回溯并等它结束；调试器缺失或卡住时，将死的进程会多挂一阵。设置后直接中止。
 * 这是上游的行为；打包的 whisper.cpp 带的 ggml 版本是否有这段未核实，但设置本身没有副作用。
 * 只对 POSIX 有意义；用户自己设过就尊重用户的值。
 */
export function applyNativeCrashEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const applied: string[] = [];
  if (platform !== 'win32' && env.GGML_NO_BACKTRACE === undefined) {
    env.GGML_NO_BACKTRACE = '1';
    applied.push('GGML_NO_BACKTRACE');
  }
  return applied;
}
