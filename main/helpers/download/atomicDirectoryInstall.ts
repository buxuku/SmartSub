import * as fs from 'fs';
import * as path from 'path';

export interface AtomicDirectoryInstallOptions {
  stagedDir: string;
  destDir: string;
  backupDir: string;
  onCleanupWarning?: (message: string) => void;
}

/**
 * 将同一父目录下已校验的 staging 目录提交为最终模型目录。
 *
 * 已有目录先改名为 backup；新目录提交失败时恢复旧目录。提交成功后即使
 * backup 清理失败也保留新目录，并仅通过 warning 报告，避免把成功安装误报为失败。
 */
export async function commitStagedDirectory(
  options: AtomicDirectoryInstallOptions,
): Promise<void> {
  const { stagedDir, destDir, backupDir, onCleanupWarning } = options;
  if (path.dirname(stagedDir) !== path.dirname(destDir)) {
    throw new Error('staged and destination directories must share a parent');
  }
  if (path.dirname(backupDir) !== path.dirname(destDir)) {
    throw new Error('backup and destination directories must share a parent');
  }

  await fs.promises.rm(backupDir, { recursive: true, force: true });
  const hadExisting = fs.existsSync(destDir);
  if (hadExisting) {
    await fs.promises.rename(destDir, backupDir);
  }

  try {
    await fs.promises.rename(stagedDir, destDir);
  } catch (error) {
    if (hadExisting && fs.existsSync(backupDir)) {
      await fs.promises.rm(destDir, { recursive: true, force: true });
      await fs.promises.rename(backupDir, destDir);
    }
    throw error;
  }

  if (hadExisting) {
    try {
      await fs.promises.rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      onCleanupWarning?.(
        `failed to remove model backup ${backupDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
