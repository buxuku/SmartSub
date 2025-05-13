import path from 'path';
import { Provider, TranslationResult } from './types';
import { CONTENT_TEMPLATES } from './constants';
import { parseSubtitles } from './utils/subtitle';
import { createOrClearFile, appendToFile, readFileContent } from './utils/file';
import {
  translateWithProvider,
  TRANSLATOR_MAP,
} from './services/translationProvider';
import { getSrtFileName, renderTemplate } from '../helpers/utils';
import { logMessage } from '../helpers/storeManager';
import { IFiles } from '../../types';

export default async function translate(
  event,
  file: IFiles,
  formData: any,
  provider: Provider,
  onProgress?: (progress: number) => void,
  maxRetries?: number,
): Promise<boolean> {
  const {
    translateContent,
    targetSrtSaveOption,
    customTargetSrtFileName,
    sourceLanguage,
    targetLanguage,
    translateRetryTimes,
  } = formData || {};
  const { fileName, directory, srtFile } = file;

  // 如果参数中有指定重试次数，则使用参数值，否则使用表单中的值或默认为2
  const retryCount =
    maxRetries !== undefined
      ? maxRetries
      : translateRetryTimes
        ? parseInt(translateRetryTimes)
        : 2;
  const renderContentTemplate = CONTENT_TEMPLATES[translateContent];

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    logMessage(
      `Translation started using ${provider.type}, max retries: ${retryCount}`,
      'info',
    );

    const data = await readFileContent(srtFile);
    const subtitles = parseSubtitles(data);

    const templateData = {
      fileName,
      sourceLanguage,
      targetLanguage,
      model: '',
      translateProvider: provider.name,
    };
    const targetSrtFileName = getSrtFileName(
      targetSrtSaveOption,
      fileName,
      targetLanguage,
      customTargetSrtFileName,
      templateData,
    );

    const fileSave = path.join(directory, `${targetSrtFileName}.srt`);
    await createOrClearFile(fileSave);

    const handleTranslationResult = async (result: TranslationResult) => {
      const content = `${result.id}\n${result.startEndTime}\n${renderTemplate(
        renderContentTemplate,
        {
          sourceContent: result.sourceContent,
          targetContent: result.targetContent,
        },
      )}`;
      logMessage(`append to file ${fileSave}`);
      await appendToFile(fileSave, content);
    };

    await translateWithProvider(
      provider,
      subtitles,
      sourceLanguage,
      targetLanguage,
      translator,
      onProgress,
      handleTranslationResult,
      retryCount,
    );

    logMessage('Translation completed', 'info');
    return true;
  } catch (error) {
    event.sender.send('message', error.message || error);
    throw error;
  }
}

export async function testTranslation(
  provider: Provider,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const testSubtitle = {
    id: '1',
    startEndTime: '00:00:01,000 --> 00:00:04,000',
    content: ['Hello China'],
  };

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    const results = await translateWithProvider(
      provider,
      [testSubtitle],
      sourceLanguage,
      targetLanguage,
      translator,
    );

    if (provider.isAi && provider.useBatchTranslation) {
      return (results as string[])[0];
    } else {
      return (results as TranslationResult[])[0].targetContent;
    }
  } catch (error) {
    throw error;
  }
}
