import type { EmbeddedSubtitleStream } from './embeddedSubtitleParser';

const MP4_FAMILY = new Set(['.mp4', '.m4v', '.mov']);
const COPY_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);
const MOV_PCM_CODECS = new Set([
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s24be',
  'pcm_s32le',
  'pcm_s32be',
  'pcm_f32le',
  'pcm_f32be',
  'pcm_f64le',
  'pcm_f64be',
  'pcm_u8',
  'pcm_alaw',
  'pcm_mulaw',
]);

/** Overrides for original audio tracks mapped in their source order after -c:a copy. */
export function buildAudioCodecOptions(
  extension: string,
  audioCodecs: readonly string[],
  firstOutputIndex = 0,
): string[] {
  const target = extension.toLowerCase();
  if (!MP4_FAMILY.has(target)) return [];
  return audioCodecs.flatMap((codec, index) => {
    const normalized = codec.toLowerCase();
    if (
      COPY_AUDIO_CODECS.has(normalized) ||
      (target === '.mov' && MOV_PCM_CODECS.has(normalized))
    )
      return [];
    const outputIndex = firstOutputIndex + index;
    return [`-c:a:${outputIndex}`, 'aac', `-b:a:${outputIndex}`, '192k'];
  });
}

/** Convert incompatible text tracks without flattening native ASS styles or bitmap tracks. */
export function buildSubtitleCodecOptions(
  extension: string,
  streams: readonly EmbeddedSubtitleStream[],
  firstOutputIndex = 0,
): string[] {
  const target = extension.toLowerCase();
  return streams.flatMap((stream) => {
    const outputIndex = firstOutputIndex + stream.subIndex;
    if (MP4_FAMILY.has(target)) {
      if (!stream.isText)
        throw new Error('MP4 cannot retain bitmap subtitle tracks; choose MKV');
      return stream.codec === 'mov_text'
        ? []
        : [`-c:s:${outputIndex}`, 'mov_text'];
    }
    if (target === '.mkv' && ['mov_text', 'text'].includes(stream.codec)) {
      return [`-c:s:${outputIndex}`, 'srt'];
    }
    return [];
  });
}
