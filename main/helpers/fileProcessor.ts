import path from 'path';
import fs from 'fs';
import { logMessage } from './storeManager';
import { createMessageSender } from './messageHandler';
import { getSrtFileName } from './utils';
import {
  extractAudioFromVideo,
  probeEmbeddedSubtitles,
  extractEmbeddedSubtitle,
} from './audioProcessor';
import { canHaveEmbeddedSubtitle, srtHasCues } from './embeddedSubtitleParser';
import { routeTranscription } from './transcriptionRouter';
import {
  getDesiredChineseScript,
  convertChineseText,
  removeChineseSubtitlePunctuation,
} from './chineseConvert';
import translate from '../translate';
import { ensureTempDir, getMd5 } from './fileUtils';
import { IFiles } from '../../types';
import {
  convertSubtitleContent,
  getFormatExtension,
  isSupportedSubtitleFormat,
  SubtitleFormat,
} from './subtitleFormats';
import { writeProofreadDataFromFiles } from './proofreadData';
import {
  throwIfTaskCancelled,
  isTaskCancelled,
  isTaskCancelledError,
  isWhisperAbortError,
  TaskCancelledError,
} from './taskContext';

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
  try {
    return await routeTranscription({
      event,
      file,
      formData,
      hasOpenAiWhisper,
    });
  } catch (error) {
    if (isTaskCancelledError(error) || isWhisperAbortError(error)) {
      throw error instanceof TaskCancelledError
        ? error
        : new TaskCancelledError();
    }
    onError(event, file, 'extractSubtitle', error);
    throw error; // 继续抛出错误，以便上层函数知道发生了错误
  }
}

/**
 * 解析用户选择的输出字幕格式，非法值回退为 srt。
 */
function resolveOutputFormat(formData): SubtitleFormat {
  const fmt = formData?.subtitleOutputFormat;
  return isSupportedSubtitleFormat(fmt) ? fmt : 'srt';
}

/**
 * 将规范 SRT 交付字幕转换为目标格式，写入新扩展名文件并删除原 .srt。
 * 整个处理流程内部始终使用 SRT，仅在最终交付物上做一次格式转换，
 * 以隔离各格式差异、最大限度降低对既有流程的影响。
 * 返回转换后的新文件路径。
 */
async function convertDeliverable(
  srtPath: string,
  format: SubtitleFormat,
): Promise<string> {
  const ext = getFormatExtension(format);
  const newPath = srtPath.replace(/\.srt$/i, ext);
  const content = await fs.promises.readFile(srtPath, 'utf-8');
  const converted = convertSubtitleContent(content, 'srt', format);
  await fs.promises.writeFile(newPath, converted, 'utf-8');
  if (newPath !== srtPath) {
    try {
      fs.unlinkSync(srtPath);
    } catch (err) {
      logMessage(`删除中间 srt 文件失败: ${err}`, 'warning');
    }
  }
  return newPath;
}

/**
 * 源字幕中文标点去除（issue #330）：把中文标点替换为空格并清理空白，原位写回。
 * 仅清理文本；SRT 序号/时间码为 ASCII，不受 CJK 标点正则影响。失败仅告警，不阻断主流程。
 */
async function stripSourceSubtitlePunctuation(
  srtFile: string,
  fileName: string,
): Promise<void> {
  try {
    throwIfTaskCancelled();
    const original = await fs.promises.readFile(srtFile, 'utf-8');
    const cleaned = removeChineseSubtitlePunctuation(original);
    if (cleaned !== original) {
      await fs.promises.writeFile(srtFile, cleaned, 'utf-8');
      logMessage(
        `removed Chinese punctuation from source subtitle: ${fileName}`,
        'info',
      );
    }
  } catch (error) {
    if (isTaskCancelledError(error) || isTaskCancelled()) throw error;
    logMessage(`source punctuation removal failed: ${error}`, 'warning');
  }
}

/**
 * 翻译字幕
 */
async function translateSubtitle(event, file: IFiles, formData, provider) {
  // 强制发送翻译开始状态
  event.sender.send('taskFileChange', {
    ...file,
    translateSubtitle: 'loading',
    translateSubtitleProgress: 0,
  });

  // 强制发送初始进度
  event.sender.send('taskProgressChange', file, 'translateSubtitle', 0);

  const onProgress = (progress) => {
    const normalizedProgress = Math.min(Math.max(progress, 0), 100);
    event.sender.send(
      'taskProgressChange',
      file,
      'translateSubtitle',
      normalizedProgress,
    );
  };

  try {
    await translate(event, file, formData, provider, onProgress);

    // 确保最终状态的正确发送
    event.sender.send('taskProgressChange', file, 'translateSubtitle', 100);
    event.sender.send('taskFileChange', {
      ...file,
      translateSubtitle: 'done',
      translateSubtitleProgress: 100,
    });

    logMessage(
      `Translation completed successfully for ${file.fileName}`,
      'info',
    );
  } catch (error) {
    if (isTaskCancelledError(error) || isTaskCancelled()) {
      // 用户取消：翻译阶段回退为待处理，不计错误，并中止后续流程
      event.sender.send('taskFileChange', {
        ...file,
        translateSubtitle: '',
        translateSubtitleProgress: 0,
      });
      throw new TaskCancelledError();
    }
    // 确保错误状态下也发送当前进度（从文件状态获取）
    onError(event, file, 'translateSubtitle', error);
  }
}

/**
 * 处理文件
 */
export async function processFile(
  event,
  file: IFiles,
  formData,
  hasOpenAiWhisper,
  provider,
) {
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

  // 进入处理前清理上一轮残留的阶段状态/进度/错误。后续 taskFileChange 习惯铺开整个 file
  // （`{ ...file, extractSubtitle: 'loading' }`），若 file 仍带着旧值——尤其取消时回灌的空串
  // ——渲染层 `{ ...prev, ...res }` 合并会把刚置好的新状态覆盖回去，造成「取消→重启」时
  // 提取格子被打回灰色、进度永远卡 50%。清成「无此键」后，铺开就不会再携带陈旧阶段状态。
  for (const k of [
    'extractAudio',
    'extractSubtitle',
    'prepareSubtitle',
    'translateSubtitle',
    'extractAudioProgress',
    'extractSubtitleProgress',
    'translateSubtitleProgress',
    'extractAudioError',
    'extractSubtitleError',
    'translateSubtitleError',
  ]) {
    delete (file as any)[k];
  }

  try {
    const { filePath, fileName, fileExtension, directory } = file;
    console.log('filePath', file);

    const isSubtitleFile = [
      '.srt',
      '.vtt',
      '.ass',
      '.ssa',
      '.lrc',
      '.txt',
    ].includes(fileExtension);
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
        translateProvider: provider?.name || '',
      };

      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData,
      );

      file.srtFile = path.join(directory, `${sourceSrtFileName}.srt`);

      // 优先尝试直接抽取内封文本软字幕：命中则复用「提取/听写」两节点、跳过抽音频 + ASR
      let usedEmbedded = false;
      if (canHaveEmbeddedSubtitle(fileExtension)) {
        try {
          throwIfTaskCancelled();
          const textTracks = (await probeEmbeddedSubtitles(filePath)).filter(
            (t) => t.isText,
          );
          if (textTracks.length > 0) {
            const picked = textTracks[0];
            logMessage(
              `found ${textTracks.length} embedded text subtitle(s) in ${fileName}, extracting track s:${picked.subIndex} (${picked.codec})`,
              'info',
            );
            // 提取节点：抽第一条文本轨
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: 'loading',
            });
            await extractEmbeddedSubtitle(
              filePath,
              picked.subIndex,
              file.srtFile,
              event,
              file,
            );
            const srtContent = fs.readFileSync(file.srtFile, 'utf-8');
            if (!srtHasCues(srtContent)) {
              throw new Error('extracted embedded subtitle has no cues');
            }
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: 'done',
            });
            // 听写节点：字幕文件已就绪
            event.sender.send('taskFileChange', {
              ...file,
              extractSubtitle: 'loading',
            });
            event.sender.send('taskFileChange', {
              ...file,
              extractSubtitle: 'done',
              embeddedSubtitle: true,
            });
            usedEmbedded = true;
          }
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) {
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: '',
              extractSubtitle: '',
            });
            throw new TaskCancelledError();
          }
          logMessage(
            `embedded subtitle extraction failed for ${fileName}, fallback to ASR: ${error}`,
            'warning',
          );
        }
      }

      if (!usedEmbedded) {
        try {
          // 提取音频
          logMessage(`extract audio for ${fileName}`, 'info');
          event.sender.send('taskFileChange', {
            ...file,
            extractAudio: 'loading',
            embeddedSubtitle: false,
          });
          throwIfTaskCancelled();
          const tempAudioFile = await extractAudioFromVideo(event, file);
          event.sender.send('taskFileChange', {
            ...file,
            extractAudio: 'done',
          });

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
          throwIfTaskCancelled();
          await generateSubtitle(event, file, formData, hasOpenAiWhisper);
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) {
            // 用户取消：把本轮 loading 阶段回退为待处理
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: '',
              extractSubtitle: '',
            });
            throw new TaskCancelledError();
          }
          // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
          // 这里只需要继续抛出错误，中断后续流程
          throw error;
        }
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

    // 中文简繁归一：仅对「转写/内封提取生成」的源字幕生效（不动用户导入的字幕文件）。
    // 源语言选中文时，按其简/繁取向把产物统一字形；检测到相反字形才实际改写。
    if (!isSubtitleFile && shouldGenerateSubtitle && file.srtFile) {
      const desiredScript = getDesiredChineseScript(sourceLanguage);
      if (desiredScript) {
        try {
          throwIfTaskCancelled();
          const original = await fs.promises.readFile(file.srtFile, 'utf-8');
          const { text, converted } = convertChineseText(
            original,
            desiredScript,
          );
          if (converted) {
            await fs.promises.writeFile(file.srtFile, text, 'utf-8');
            logMessage(
              `normalized source subtitle to ${desiredScript} Chinese: ${fileName}`,
              'info',
            );
          }
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) throw error;
          // 转换失败不应阻断主流程：记录告警并沿用原始字幕
          logMessage(
            `chinese script normalization failed: ${error}`,
            'warning',
          );
        }
      }
    }

    // 源字幕中文标点去除 · generateOnly：转写后即剥离（无翻译下游，零风险）
    if (
      !isSubtitleFile &&
      shouldGenerateSubtitle &&
      taskType === 'generateOnly' &&
      file.srtFile &&
      formData?.removeChinesePunctuation === true &&
      getDesiredChineseScript(sourceLanguage)
    ) {
      await stripSourceSubtitlePunctuation(file.srtFile, fileName);
    }

    // 翻译字幕（取消后不再进入）
    throwIfTaskCancelled();
    if (shouldTranslateSubtitle && translateProvider !== '-1') {
      if (!provider) {
        // '-1' 历史残留或服务商已被删除：明确报错而非深层崩溃
        const errorMsg = `translate provider not found: ${translateProvider}`;
        onError(event, file, 'translateSubtitle', new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logMessage(`translate subtitle ${file.srtFile}`, 'info');
      await translateSubtitle(event, file, formData, provider);
    }

    // 源字幕中文标点去除 · generateAndTranslate：翻译完成后再剥离源交付物，
    // 保留翻译输入的标点以护断句；noSave 时源字幕随后会被清理，无需处理。
    if (
      !isSubtitleFile &&
      shouldGenerateSubtitle &&
      taskType === 'generateAndTranslate' &&
      sourceSrtSaveOption !== 'noSave' &&
      file.srtFile &&
      fs.existsSync(file.srtFile) &&
      formData?.removeChinesePunctuation === true &&
      getDesiredChineseScript(sourceLanguage)
    ) {
      await stripSourceSubtitlePunctuation(file.srtFile, fileName);
    }

    if (file.srtFile && fs.existsSync(file.srtFile)) {
      const proofreadDataFile = await writeProofreadDataFromFiles({
        file,
        sourceFile: file.srtFile,
        targetFile:
          shouldTranslateSubtitle && translateProvider !== '-1'
            ? file.tempTranslatedSrtFile || file.translatedSrtFile
            : undefined,
        finalTargetFile:
          shouldTranslateSubtitle && translateProvider !== '-1'
            ? file.translatedSrtFile
            : undefined,
        sourceLanguage,
        targetLanguage,
        translateContent: formData?.translateContent,
        outputFormat: formData?.subtitleOutputFormat,
      });
      if (proofreadDataFile) {
        file.proofreadDataFile = proofreadDataFile;
        event.sender.send('taskFileChange', file);
      }
    }

    // 将交付字幕转换为用户选择的输出格式（内部流程始终为 SRT，此处仅转换最终交付物）
    const outputFormat = resolveOutputFormat(formData);
    if (outputFormat !== 'srt') {
      // 源字幕：仅在由 ASR 生成且需要保存时转换（noSave 时源字幕会被清理，保持 srt）
      if (
        !isSubtitleFile &&
        shouldGenerateSubtitle &&
        sourceSrtSaveOption !== 'noSave' &&
        file.srtFile &&
        fs.existsSync(file.srtFile)
      ) {
        try {
          file.srtFile = await convertDeliverable(file.srtFile, outputFormat);
          logMessage(`source subtitle converted to ${outputFormat}`, 'info');
        } catch (err) {
          logMessage(`转换源字幕格式失败: ${err}`, 'error');
        }
      }
      // 翻译字幕交付物
      if (
        shouldTranslateSubtitle &&
        translateProvider !== '-1' &&
        file.translatedSrtFile &&
        fs.existsSync(file.translatedSrtFile)
      ) {
        try {
          file.translatedSrtFile = await convertDeliverable(
            file.translatedSrtFile,
            outputFormat,
          );
          logMessage(
            `translated subtitle converted to ${outputFormat}`,
            'info',
          );
        } catch (err) {
          logMessage(`转换翻译字幕格式失败: ${err}`, 'error');
        }
      }
      event.sender.send('taskFileChange', file);
    }

    // 清理临时文件：仅在「生成并翻译」且确实产生了译文交付物时才删除源字幕。
    // 「仅生成字幕」任务的源字幕是最终交付物，绝不能因 noSave 而被删除。
    if (
      !isSubtitleFile &&
      sourceSrtSaveOption === 'noSave' &&
      shouldGenerateSubtitle &&
      shouldTranslateSubtitle &&
      translateProvider !== '-1'
    ) {
      const { srtFile } = file;
      logMessage(`delete temp subtitle ${srtFile}`, 'warning');
      // 缓存一份到临时文件，用于字幕校对
      const tempDir = ensureTempDir();
      const md5FileName = getMd5(filePath);
      const tempSrtFile = path.join(tempDir, `${md5FileName}.srt`);
      file.tempSrtFile = tempSrtFile;
      // 清除已删除文件的路径，确保校对时使用临时目录的文件
      file.srtFile = undefined;
      event.sender.send('taskFileChange', file);
      fs.copyFileSync(srtFile, tempSrtFile);
      fs.unlink(srtFile, (err) => {
        if (err) console.log(err);
      });
    }

    logMessage(`process file done ${fileName}`, 'info');
  } catch (error) {
    if (isTaskCancelledError(error) || isTaskCancelled()) {
      logMessage(`processing cancelled: ${file.fileName}`, 'warning');
      event.sender.send('taskFileChange', {
        ...file,
        extractAudio: '',
        extractSubtitle: '',
        translateSubtitle: '',
      });
      return;
    }
    // 使用通用错误处理方法
    createMessageSender(event.sender).send('message', {
      type: 'error',
      message: error,
    });
  }
}
