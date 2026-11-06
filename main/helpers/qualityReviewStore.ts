import { createProofreadDraftStore } from './proofreadDraftStore';
import {
  parseQualityReview,
  type QualityReviewState,
} from '../../types/qualityReview';

/** Reuse fsync + atomic rename, in a separate directory from recovery drafts. */
export function createQualityReviewStore(directory: string) {
  const files = createProofreadDraftStore(directory);
  return {
    read(key: string): QualityReviewState {
      const raw = files.read(key);
      return parseQualityReview(raw ? JSON.parse(raw) : null);
    },
    save(key: string, state: unknown) {
      files.write(key, JSON.stringify(parseQualityReview(state)));
    },
  };
}
