import { z } from 'zod';
import type {
  SubtitleStyle,
  MergeOutputMode,
  VideoQuality,
  EncoderMode,
} from '../../types/subtitleMerge';

export interface ComposeDocument {
  videoPath: string | null;
  subtitlePath: string | null;
  audioTrackPath: string | null;
  audioTrackMode: 'replace' | 'mix' | 'addTrack';
  style: SubtitleStyle;
  activePresetId: string | null;
  outputPath: string | null;
  outputMode: MergeOutputMode;
  softContainer: 'mkv' | 'mp4';
  videoQuality: VideoQuality;
  encoderMode: EncoderMode;
}
// Drafts must preserve partially typed fields as well as finished settings.
const color = z.string();
// Numeric controls can temporarily contain out-of-range values while editing.
// Semantic validation belongs to export, not recovery of the user's input.
const numeric = z.number().finite();
const documentSchema = z.object({
  videoPath: z.string().nullable(),
  subtitlePath: z.string().nullable(),
  audioTrackPath: z.string().nullable(),
  audioTrackMode: z.enum(['replace', 'mix', 'addTrack']),
  style: z.object({
    fontName: z.string(),
    fontSize: numeric,
    primaryColor: color,
    outlineColor: color,
    backColor: color,
    backOpacity: numeric.optional(),
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    borderStyle: z.union([z.literal(1), z.literal(3)]),
    outline: numeric,
    shadow: numeric,
    alignment: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
    ]),
    marginL: numeric,
    marginR: numeric,
    marginV: numeric,
    positionY: numeric.optional(),
    positionReferenceY: numeric.optional(),
    secondLineColor: color.optional(),
    highlightColor: color.optional(),
    highlightTerms: z.array(z.string()).optional(),
    glowColor: color.optional(),
    glow: numeric.optional(),
  }),
  activePresetId: z.string().nullable(),
  outputPath: z.string().nullable(),
  outputMode: z.enum(['hardcode', 'softmux']),
  softContainer: z.enum(['mkv', 'mp4']),
  videoQuality: z.enum(['original', 'high', 'standard']),
  encoderMode: z.enum(['cpu', 'hardware']),
});
const schema = z.object({
  version: z.literal(1),
  current: documentSchema,
  saved: documentSchema,
  dirty: z.boolean(),
  job: z
    .object({ requestId: z.string().optional(), jobId: z.string().optional() })
    .nullable()
    .optional(),
});
export interface ComposeJobReference {
  requestId?: string;
  jobId?: string;
}
export interface ComposeDraft {
  version: 1;
  current: ComposeDocument;
  saved: ComposeDocument;
  dirty: boolean;
  // Undefined is a legacy draft; null explicitly detaches from previous jobs.
  job?: ComposeJobReference | null;
}
const memory = new Map<string, { draft: ComposeDraft; base: string | null }>();
export const cloneCompose = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
export const composeDraftKey = (video?: string, subtitle?: string) =>
  `smartsub_compose_draft_v1:${JSON.stringify([video || '', subtitle || ''])}`;

export function readComposeDraft(key: string): ComposeDraft | null {
  const raw = localStorage.getItem(key);
  const unsaved = memory.get(key);
  if (unsaved && unsaved.base === raw) return cloneCompose(unsaved.draft);
  memory.delete(key);
  if (!raw) return null;
  const parsed = schema.parse(JSON.parse(raw)) as ComposeDraft;
  return cloneCompose(parsed);
}
export function writeComposeDraft(
  key: string,
  draft: ComposeDraft,
  commit = false,
): void {
  const snapshot = cloneCompose(draft);
  // Retain unsaved work in memory, but never claim a failed save succeeded.
  if (!commit)
    memory.set(key, { draft: snapshot, base: localStorage.getItem(key) });
  localStorage.setItem(key, JSON.stringify(snapshot));
  memory.delete(key);
}
export function clearComposeDraft(key: string): void {
  localStorage.removeItem(key);
  memory.delete(key);
}
