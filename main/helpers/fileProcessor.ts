import path from 'path';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { createMessageSender } from './messageHandler';
import { getSrtFileName } from './utils';
import { extractAudioFromVideo } from './audioProcessor';
import {
  generateSubtitleWithLocalWhisper,
  generateSubtitleWithBuiltinWhisper,
} from './subtitleGenerator';
import translate from '../translate';
import type { IpcMainEvent } from 'electron';
import type { Provider, IFiles } from '../../types';
import { ensureTempDir, getMd5 } from './fileUtils';

/**
 * 处理任务错误
 */
function onError(event, file, key, error) {
  const errorMsg = error?.message || error?.toString() || '未知错误';
  logMessage(`${key} error: ${errorMsg}`, 'error');
  event.sender.send('taskStatusChange', file, key, 'error');
  event.sender.send('taskErrorChange', file, key, errorMsg);

  // 发送错误消息通知
  createMessageSender(event.sender).send('message', {
    type: 'error',
    message: errorMsg,
  });
}

/**
 * 生成字幕
 */
async function generateSubtitle(
  event,
  file: IFiles,
  formData,
  hasOpenAiWhisper,
) {
  const settings = store.get('settings');
  const useLocalWhisper = settings?.useLocalWhisper;

  try {
    if (hasOpenAiWhisper && useLocalWhisper && settings?.whisperCommand) {
      return await generateSubtitleWithLocalWhisper(event, file, formData);
    } else {
      return await generateSubtitleWithBuiltinWhisper(event, file, formData);
    }
  } catch (error) {
    onError(event, file, 'extractSubtitle', error);
    throw error; // 继续抛出错误，以便上层函数知道发生了错误
  }
}

/**
 * 翻译字幕
 */
async function translateSubtitle(event, file: IFiles, formData, provider) {
  event.sender.send('taskFileChange', {
    ...file,
    translateSubtitle: 'loading',
  });

  const onProgress = (progress) => {
    event.sender.send(
      'taskProgressChange',
      file,
      'translateSubtitle',
      Math.min(progress, 100),
    );
  };
  try {
    await translate(event, file, formData, provider, onProgress);
    event.sender.send('taskFileChange', { ...file, translateSubtitle: 'done' });
  } catch (error) {
    onError(event, file, 'translateSubtitle', error);
  }
}

/**
 * 处理文件
 */
export async function processFile(
  event: IpcMainEvent,
  file: IFiles,
  hasOpenAiWhisper: boolean,
  provider: Provider,
) {
  const { formData = {} } = file;

  const {
    sourceLanguage,
    targetLanguage,
    sourceSrtSaveOption,
    customSourceSrtFileName,
    model,
    translateProvider,
    saveAudio,
    taskType,
  } = formData || {};

  try {
    const { filePath, fileName, fileExtension, directory } = file;
    console.log('filePath', file);

    const isSubtitleFile = ['.srt', '.vtt', '.ass', '.ssa'].includes(
      fileExtension,
    );
    logMessage(`begin process ${fileName} with task type: ${taskType}`, 'info');

    // 确定是否需要生成字幕
    const shouldGenerateSubtitle =
      taskType === 'generateAndTranslate' || taskType === 'generateOnly';

    // 确定是否需要翻译字幕
    const shouldTranslateSubtitle =
      taskType === 'generateAndTranslate' || taskType === 'translateOnly';

    // 处理非字幕文件 - 需要生成字幕的情况
    if (!isSubtitleFile && shouldGenerateSubtitle) {
      const templateData = {
        fileName,
        sourceLanguage,
        targetLanguage,
        model,
        translateProvider: provider.name,
      };

      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData,
      );

      file.srtFile = path.join(directory, `${sourceSrtFileName}.srt`);

      try {
        // 提取音频
        logMessage(`extract audio for ${fileName}`, 'info');
        event.sender.send('taskFileChange', {
          ...file,
          extractAudio: 'loading',
        });
        const tempAudioFile = await extractAudioFromVideo(event, file);
        event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });

        // 如果开启了保存音频选项，则复制一份到视频同目录
        if (saveAudio) {
          const audioFileName = `${fileName}.wav`;
          const targetAudioPath = path.join(directory, audioFileName);
          file.audioFile = targetAudioPath;
          logMessage(`Saving audio file to: ${targetAudioPath}`, 'info');
          fs.copyFileSync(tempAudioFile, targetAudioPath);
        }

        // 生成字幕
        logMessage(`generate subtitle ${file.srtFile}`, 'info');
        await generateSubtitle(event, file, formData, hasOpenAiWhisper);
      } catch (error) {
        // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
        // 这里只需要继续抛出错误，中断后续流程
        throw error;
      }
    } else if (isSubtitleFile) {
      // 处理字幕文件
      file.srtFile = filePath;
      try {
        event.sender.send('taskFileChange', {
          ...file,
          prepareSubtitle: 'loading',
        });
        // 这里可以添加字幕格式转换的逻辑，如果需要的话
        event.sender.send('taskFileChange', {
          ...file,
          prepareSubtitle: 'done',
        });
      } catch (error) {
        onError(event, file, 'prepareSubtitle', error);
        throw error;
      }
    } else if (!isSubtitleFile && !shouldGenerateSubtitle) {
      // 非字幕文件且不需要生成字幕的情况（只翻译模式下传入了视频文件）
      const errorMsg = '只翻译模式下不能处理视频文件，请提供字幕文件';
      onError(event, file, 'processFile', new Error(errorMsg));
      throw new Error(errorMsg);
    }

    // 翻译字幕
    if (shouldTranslateSubtitle && translateProvider !== '-1') {
      logMessage(`translate subtitle ${file.srtFile}`, 'info');
      await translateSubtitle(event, file, formData, provider);
    }
    // 清理临时文件
    if (
      !isSubtitleFile &&
      sourceSrtSaveOption === 'noSave' &&
      shouldGenerateSubtitle
    ) {
      const { srtFile } = file;
      logMessage(`delete temp subtitle ${srtFile}`, 'warning');
      // 缓存一份到临时文件，用于字幕校对
      const tempDir = ensureTempDir();
      const md5FileName = getMd5(filePath);
      const tempSrtFile = path.join(tempDir, `${md5FileName}.srt`);
      file.tempSrtFile = tempSrtFile;
      event.sender.send('taskFileChange', file);
      fs.copyFileSync(srtFile, tempSrtFile);
      fs.unlink(srtFile, (err) => {
        if (err) console.log(err);
      });
    }

    logMessage(`process file done ${fileName}`, 'info');
  } catch (error) {
    // 使用通用错误处理方法
    createMessageSender(event.sender).send('message', {
      type: 'error',
      message: error,
    });
  }
}
