/**
 * ffmpeg 失败诊断的纯逻辑（issue #370）。
 *
 * 背景：fluent-ffmpeg 拼 err.message 时（utils.extractError）会丢弃以 `[` 或空格
 * 开头的 stderr 行，而 ffmpeg 6+ 的致命错误恰好带 `[out#0/...]` 标签前缀，导致
 * 用户日志里只剩 "ffmpeg exited with code 1: "——真实原因必须从 error 回调的
 * stderr 参数里自行截取。
 */

/** 取 stderr 尾部若干非空行（诊断日志用）。 */
export function stderrTail(stderr?: string, maxLines = 8): string {
  if (!stderr) return '';
  return stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-maxLines)
    .join('\n');
}

/**
 * 把 ffmpeg 常见失败映射为用户可读错误；未命中时把 stderr 最后一行拼进原错误，
 * 避免界面上只显示空洞的 "ffmpeg exited with code 1: "。
 */
export function toFriendlyFfmpegError(err: Error, stderr?: string): Error {
  const tail = stderrTail(stderr, 20);
  if (/does not contain any stream/i.test(tail)) {
    return new Error(
      '该文件不包含音频轨道（网页版视频下载工具常只抓到纯视频流），请用能合并音视频的下载工具（如 yt-dlp）重新下载',
    );
  }
  if (
    /moov atom not found|invalid data found when processing input/i.test(tail)
  ) {
    return new Error('该文件已损坏或下载不完整，请确认本地能正常播放后重试');
  }
  const lastLine = tail.split('\n').pop() || '';
  if (lastLine && err?.message?.trim().endsWith(':')) {
    err.message = `${err.message}${lastLine}`;
  }
  return err;
}
