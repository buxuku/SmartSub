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

export default async function translate(
  event,
  folder: string,
  fileName: string,
  absolutePath: string,
  formData: any,
  provider: Provider,
  onProgress?: (progress: number) => void,
): Promise<boolean> {
  const {
    translateContent,
    targetSrtSaveOption,
    customTargetSrtFileName,
    sourceLanguage,
    targetLanguage,
  } = formData || {};

  const renderContentTemplate = CONTENT_TEMPLATES[translateContent];

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    logMessage(`Translation started using ${provider.type}`, 'info');

    const data = await readFileContent(absolutePath);
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

    const fileSave = path.join(folder, `${targetSrtFileName}.srt`);
    await createOrClearFile(fileSave);

    const results = await translateWithProvider(
      provider,
      subtitles,
      sourceLanguage,
      targetLanguage,
      translator,
      onProgress,
    );

    //   if (provider.isAi && provider.useBatchTranslation) {
    // logMessage(`append to file ${fileSave}`)
    //     await appendToFile(fileSave, (results as string[]).join('\n'));
    //     return true;
    //   }

    for (const result of results as TranslationResult[]) {
      const content = `${result.id}\n${result.startEndTime}\n${renderTemplate(
        renderContentTemplate,
        {
          sourceContent: result.sourceContent,
          targetContent: result.targetContent,
        },
      )}`;
      logMessage(`append to file ${fileSave}`);
      await appendToFile(fileSave, content);
    }

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
