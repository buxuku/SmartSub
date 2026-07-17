import fs from 'fs';

export interface PreparedDownloadTarget {
  complete: boolean;
  startByte: number;
}

/**
 * 按远端声明大小整理最终文件和续传临时文件。
 * 旧版本留下的短最终文件会转为 .download 继续下载；超长文件会被丢弃重下。
 */
export function prepareDownloadTarget(
  destPath: string,
  tempPath: string,
  expectedSize: number,
): PreparedDownloadTarget {
  if (fs.existsSync(destPath)) {
    const actualSize = fs.statSync(destPath).size;
    if (actualSize === expectedSize) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      return { complete: true, startByte: 0 };
    }

    if (
      actualSize > 0 &&
      actualSize < expectedSize &&
      !fs.existsSync(tempPath)
    ) {
      fs.renameSync(destPath, tempPath);
    } else {
      fs.rmSync(destPath, { force: true });
    }
  }

  if (!fs.existsSync(tempPath)) return { complete: false, startByte: 0 };

  const tempSize = fs.statSync(tempPath).size;
  if (tempSize === expectedSize) {
    fs.renameSync(tempPath, destPath);
    return { complete: true, startByte: 0 };
  }
  if (tempSize > expectedSize) {
    fs.rmSync(tempPath, { force: true });
    return { complete: false, startByte: 0 };
  }
  return { complete: false, startByte: tempSize };
}

export function assertFileSize(
  filePath: string,
  expectedSize: number,
  label = filePath,
): void {
  const actualSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : -1;
  if (actualSize !== expectedSize) {
    throw new Error(
      `${label} size mismatch: got ${actualSize}, expected ${expectedSize}`,
    );
  }
}

export type DownloadResponseDisposition = 'accept' | 'restart';

/** 校验单连接续传响应，避免服务端忽略 Range 后把完整响应追加到临时文件。 */
export function validateDownloadResponse(
  statusCode: number,
  contentRange: string | undefined,
  startByte: number,
  expectedSize: number,
): DownloadResponseDisposition {
  if (startByte > 0 && statusCode === 200) return 'restart';
  if (statusCode !== 200 && statusCode !== 206) {
    throw new Error(`Unexpected download status ${statusCode}`);
  }
  if (startByte > 0 && statusCode !== 206) {
    throw new Error(`Expected partial response, got ${statusCode}`);
  }

  if (statusCode === 206) {
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    if (!match) throw new Error('Invalid Content-Range response');
    const rangeStart = Number(match[1]);
    const rangeEnd = Number(match[2]);
    const total = Number(match[3]);
    if (
      rangeStart !== startByte ||
      rangeEnd < rangeStart ||
      rangeEnd >= total ||
      total !== expectedSize
    ) {
      throw new Error(
        `Content-Range mismatch: got ${contentRange}, expected bytes ${startByte}-*/${expectedSize}`,
      );
    }
  }

  return 'accept';
}
