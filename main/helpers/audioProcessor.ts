import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';
import { getMd5, ensureTempDir, timemarkToSeconds } from './fileUtils';
import { getTaskContext, TaskCancelledError } from './taskContext';

// 设置ffmpeg路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/** 正在运行的提取进程：fileUuid -> fluent-ffmpeg command（取消时 kill） */
const runningCommands = new Map<string, ReturnType<typeof ffmpeg>>();

/** 取消时终止指定文件的 ffmpeg 提取进程 */
export function killFfmpegForFiles(fileUuids: string[]) {
  for (const uuid of fileUuids) {
    const command = runningCommands.get(uuid);
    if (!command) continue;
    try {
      command.kill('SIGKILL');
      logMessage(
        `ffmpeg extraction killed for cancelled file ${uuid}`,
        'warning',
      );
    } catch (error) {
      logMessage(`ffmpeg kill failed: ${error}`, 'warning');
    }
    runningCommands.delete(uuid);
  }
}

/**
 * 使用ffmpeg提取音频
 */
export const extractAudio = (
  videoPath,
  audioPath,
  event = null,
  file = null,
) => {
  const onProgress = (percent = 0) => {
    const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
    logMessage(`extract audio progress ${safePercent}%`, 'info');
    if (event && file) {
      event.sender.send(
        'taskProgressChange',
        file,
        'extractAudio',
        safePercent,
      );
    }
  };
  // 同步捕获上下文：回调里不依赖 ALS 跨 emitter 传播
  const taskContext = getTaskContext();
  const fileUuid = file?.uuid || taskContext?.fileUuid;
  const signal = taskContext?.signal;

  const unregister = () => {
    if (fileUuid) runningCommands.delete(fileUuid);
  };

  return new Promise((resolve, reject) => {
    // fluent-ffmpeg 的 progress.percent 在部分平台/新版 ffmpeg 上恒为 undefined，
    // 这里从 codecData 拿到媒体总时长，再用 progress.timemark 自算百分比（issue #291）。
    let totalDurationSec = 0;
    try {
      const command = ffmpeg(`${videoPath}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y')
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract audio start ${str}`, 'info');
        })
        .on('codecData', function (data) {
          totalDurationSec = timemarkToSeconds(data?.duration);
          // 顺手记录媒体时长，随后续 taskFileChange 持久化供行内元信息展示
          if (file && totalDurationSec > 0) {
            file.duration = totalDurationSec;
          }
        })
        .on('progress', function (progress) {
          let percent = progress.percent;
          if (
            (percent === undefined ||
              percent === null ||
              Number.isNaN(percent) ||
              percent <= 0) &&
            totalDurationSec > 0 &&
            progress.timemark
          ) {
            percent =
              (timemarkToSeconds(progress.timemark) / totalDurationSec) * 100;
          }
          onProgress(percent || 0);
        })
        .on('end', function (str) {
          unregister();
          logMessage(`extract audio done!`, 'info');
          onProgress(100);
          resolve(true);
        })
        .on('error', function (err) {
          unregister();
          if (signal?.aborted) {
            // 用户取消导致的 kill：清理半成品，按取消路径返回
            try {
              if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (cleanupErr) {
              logMessage(
                `cleanup partial audio failed: ${cleanupErr}`,
                'warning',
              );
            }
            logMessage(`extract audio cancelled`, 'warning');
            reject(new TaskCancelledError());
            return;
          }
          logMessage(`extract audio error: ${err}`, 'error');
          reject(err);
        });
      if (fileUuid) runningCommands.set(fileUuid, command);
      command.save(`${audioPath}`);
    } catch (err) {
      unregister();
      logMessage(`ffmpeg extract audio error: ${err}`, 'error');
      reject(`${err}: ffmpeg extract audio error!`);
    }
  });
};

/**
 * 从视频中提取音频
 */
export async function extractAudioFromVideo(event, file) {
  const { filePath } = file;
  event.sender.send('taskFileChange', { ...file, extractAudio: 'loading' });
  const tempDir = ensureTempDir();

  logMessage(`tempDir: ${tempDir}`, 'info');
  const md5FileName = getMd5(filePath);
  const tempAudioFile = path.join(tempDir, `${md5FileName}.wav`);
  file.tempAudioFile = tempAudioFile;

  if (fs.existsSync(tempAudioFile)) {
    logMessage(`Using existing audio file: ${tempAudioFile}`, 'info');
    event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
    return tempAudioFile;
  }

  await extractAudio(filePath, tempAudioFile, event, file);
  event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
  return tempAudioFile;
}
