import {
  SPEAKER_DIARIZATION_METADATA_SAVE_FAILED,
  TRANSLATION_INCOMPLETE_PIPELINE_PAUSED,
  TRANSLATION_INCOMPLETE_FOR_DUBBING,
  TRANSLATION_INCOMPLETE_FOR_COMPOSE,
} from '../../../types';

/** Error and warning messages share the same code-to-text mapping in both views. */
export function formatTaskMessage(
  message: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  translationFailureCount = 0,
): string {
  switch (message) {
    case 'AI_SEGMENTATION_FALLBACK':
      return t('activity.fallbackWarning');
    case 'TASK_INTERRUPTED':
      return t('interrupted');
    case TRANSLATION_INCOMPLETE_PIPELINE_PAUSED:
      return t('row.translationIncompletePipelinePaused', {
        count: translationFailureCount,
      });
    case TRANSLATION_INCOMPLETE_FOR_DUBBING:
      return t('row.translationIncompleteForDubbing');
    case TRANSLATION_INCOMPLETE_FOR_COMPOSE:
      return t('row.translationIncompleteForCompose');
    case SPEAKER_DIARIZATION_METADATA_SAVE_FAILED:
      return t('row.speakerDiarizationMetadataSaveFailed');
  }
  if (message.startsWith('AI_CORRECTION_VALIDATION_FAILED:')) {
    return t('row.aiCorrectionValidationFailed', {
      count: Number(message.split(':')[1]),
    });
  }
  if (message.startsWith('SPEAKER_DIARIZATION_')) {
    return t(`speakerDiarization.warnings.${message}`, {
      defaultValue: message,
    });
  }
  return message;
}
