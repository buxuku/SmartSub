import ffmpegStatic from 'ffmpeg-static';

import ffmpeg from 'fluent-ffmpeg';
import { logMessage } from './storeManager';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

ffmpeg.setFfmpegPath(ffmpegPath);

export const extractAudio = (videoPath, audioPath) => {
  return new Promise((resolve, reject) => {
    try {
      ffmpeg(`${videoPath}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y')
        .on('start', function (str) {
          logMessage(`extract audio start ${str}`, 'info');
        })
        .on('progress', function (progress) {
          logMessage(
            `extract audio progress ${progress.percent || 0}%`,
            'info',
          );
        })
        .on('end', function (str) {
          logMessage(`extract audio done!`, 'info');
          resolve(true);
        })
        .on('error', function (err) {
          logMessage(`extract audio error: ${err}`, 'error');
          reject(err);
        })
        .save(`${audioPath}`);
    } catch (err) {
      logMessage(`ffmpeg extract audio error: ${err}`, 'error');
      reject(`${err}: ffmpeg extract audio error!`);
    }
  });
};
