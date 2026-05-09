import fs from 'fs-extra';
import {
  DEFAULT_TRANSCRIPTION_PROVIDER,
  type TranscriptionProviderId,
  type TranscriptionResult,
} from '../../../types';
import {
  generateSubtitleWithBuiltinWhisper,
  generateSubtitleWithLocalWhisper,
} from '../subtitleGenerator';
import { logMessage } from '../storeManager';
import { transcribeWithOpenRouter } from './openRouter';
import { transcribeWithReazonSpeech } from './reazonSpeech';
import { formatTranscriptionResultAsSrt } from './srt';

export async function generateSubtitleWithTranscriptionProvider(
  event,
  file,
  formData,
  hasOpenAiWhisper,
  isCancellationRequested?: () => boolean,
): Promise<string> {
  const provider = (formData?.transcriptionProvider ||
    DEFAULT_TRANSCRIPTION_PROVIDER) as TranscriptionProviderId;

  if (provider === 'local-whisper-command') {
    return (await generateSubtitleWithLocalWhisper(
      event,
      file,
      formData,
      isCancellationRequested,
    )) as string;
  }

  if (provider === 'builtin-whisper') {
    return (await generateSubtitleWithBuiltinWhisper(
      event,
      file,
      formData,
      isCancellationRequested,
    )) as string;
  }

  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
  const reportProgress = (progress: number) => {
    const normalizedProgress = Math.min(Math.max(progress || 0, 0), 100);
    event.sender.send(
      'taskProgressChange',
      file,
      'extractSubtitle',
      normalizedProgress,
    );
  };

  let result: TranscriptionResult;
  if (provider === 'openrouter') {
    result = await transcribeWithOpenRouter(
      file.tempAudioFile,
      formData,
      reportProgress,
      isCancellationRequested,
    );
  } else if (provider === 'reazonspeech-k2') {
    result = await transcribeWithReazonSpeech(
      file.tempAudioFile,
      formData,
      reportProgress,
      isCancellationRequested,
    );
  } else {
    throw new Error(`Unsupported transcription provider: ${provider}`);
  }

  const srt = await formatTranscriptionResultAsSrt(result, file.tempAudioFile);
  if (!srt.trim()) {
    throw new Error('转录结果为空，无法生成字幕');
  }

  await fs.writeFile(file.srtFile, srt, 'utf8');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(`generate subtitle done with ${provider}`, 'info');
  return file.srtFile;
}
