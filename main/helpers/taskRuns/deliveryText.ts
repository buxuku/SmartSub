import { parseSubtitleCues, serializeSubtitleCues } from '../subtitleFormats';
import {
  getDesiredChineseScript,
  removeChineseSubtitlePunctuation,
} from '../chineseConvert';
import { stripSpeakerLabelPrefix } from '../speakerDiarization/alignment';

/** Rendering choices are applied to delivery copies, after paid translation. */
export function renderTranslationDelivery(
  source: string,
  target: string,
  config: Record<string, any>,
) {
  const sourceCues = parseSubtitleCues(source, 'srt');
  const targetCues = parseSubtitleCues(target, 'srt');
  if (sourceCues.length !== targetCues.length)
    throw new Error('TASK_TRANSLATION_CUE_MISMATCH');
  const bilingual: Array<{ source: string; target: string }> = [];
  const cues = targetCues.map((cue, index) => {
    let sourceText = stripSpeakerLabelPrefix(sourceCues[index].text);
    let targetText = stripSpeakerLabelPrefix(cue.text);
    const prefix = cue.text.slice(0, cue.text.length - targetText.length);
    if (
      config.removeChinesePunctuation &&
      getDesiredChineseScript(config.targetLanguage)
    )
      targetText = removeChineseSubtitlePunctuation(targetText);
    if (
      config.removeChinesePunctuation &&
      config.taskType === 'generateAndTranslate' &&
      getDesiredChineseScript(config.sourceLanguage)
    )
      sourceText = removeChineseSubtitlePunctuation(sourceText);
    bilingual.push({ source: sourceText, target: targetText });
    const text =
      config.translateContent === 'sourceAndTranslate'
        ? `${sourceText}\n${targetText}`
        : config.translateContent === 'translateAndSource'
          ? `${targetText}\n${sourceText}`
          : targetText;
    return { ...cue, text: prefix + text };
  });
  return { content: serializeSubtitleCues(cues, 'srt'), bilingual };
}
