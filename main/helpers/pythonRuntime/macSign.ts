import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logMessage } from '../storeManager';

/**
 * 对目录内所有 Mach-O 原生库做 ad-hoc 重签（仅 macOS）。
 *
 * 无开发者证书时的兜底：下载到 userData 的引擎包内含 .so/.dylib，arm64 要求所有可执行
 * 代码必须签名。引擎包构建时已 ad-hoc 签过（build_engine_package.py），但若个别 wheel
 * 的库未签或签名在传输/解压后失效，dlopen 会被内核拒绝。这里再次 ad-hoc 重签兜底。
 *
 * codesign 对非 Mach-O 文件会失败，忽略即可。
 */
export function adhocResignDir(dir: string): void {
  if (process.platform !== 'darwin' || !fs.existsSync(dir)) return;
  const exts = new Set(['.so', '.dylib', '.node']);
  let count = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (exts.has(path.extname(entry.name))) {
        try {
          execFileSync('codesign', ['--force', '--sign', '-', full], {
            stdio: 'ignore',
          });
          count += 1;
        } catch {
          // 非 Mach-O 或重签失败：忽略，由 dlopen 时再暴露
        }
      }
    }
  };
  try {
    walk(dir);
    logMessage(`ad-hoc resigned ${count} native libs under ${dir}`, 'info');
  } catch (error) {
    logMessage(`ad-hoc resign skipped: ${error}`, 'warning');
  }
}
