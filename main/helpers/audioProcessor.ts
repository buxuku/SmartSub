import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';
import { getMd5, ensureTempDir } from './fileUtils';

// 设置ffmpeg路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * 使用ffmpeg提取音频
 */
export const extractAudio = (
  videoPath,
  audioPath,
  event = null,
  file = null,
  isCancellationRequested?: () => boolean,
) => {
  const onProgress = (percent = 0) => {
    logMessage(`extract audio progress ${percent}%`, 'info');
    if (event && file) {
      event.sender.send('taskProgressChange', file, 'extractAudio', percent);
    }
  };
  return new Promise((resolve, reject) => {
    try {
      if (isCancellationRequested?.()) {
        reject(new Error('任务已取消'));
        return;
      }

      let settled = false;
      let cancelTimer: ReturnType<typeof setInterval>;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(cancelTimer);
        callback();
      };

      const command = ffmpeg(`${videoPath}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y')
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract audio start ${str}`, 'info');
        })
        .on('progress', function (progress) {
          const percent = progress.percent || 0;
          onProgress(percent);
          if (isCancellationRequested?.()) {
            command.kill('SIGTERM');
          }
        })
        .on('end', function (str) {
          finish(() => {
            logMessage(`extract audio done!`, 'info');
            onProgress(100);
            resolve(true);
          });
        })
        .on('error', function (err) {
          finish(() => {
            if (isCancellationRequested?.()) {
              reject(new Error('任务已取消'));
              return;
            }
            logMessage(`extract audio error: ${err}`, 'error');
            reject(err);
          });
        });

      cancelTimer = setInterval(() => {
        if (isCancellationRequested?.()) {
          command.kill('SIGTERM');
        }
      }, 500);

      command.save(`${audioPath}`);
    } catch (err) {
      logMessage(`ffmpeg extract audio error: ${err}`, 'error');
      reject(`${err}: ffmpeg extract audio error!`);
    }
  });
};

/**
 * 从视频中提取音频
 */
export async function extractAudioFromVideo(
  event,
  file,
  isCancellationRequested?: () => boolean,
) {
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

  await extractAudio(
    filePath,
    tempAudioFile,
    event,
    file,
    isCancellationRequested,
  );
  event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
  return tempAudioFile;
}
