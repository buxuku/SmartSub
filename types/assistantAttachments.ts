import type { AssistantAttachment } from './assistant';

// Media/subtitles supported by SmartSub, plus reference manuscripts and JSON
// proofread/configuration files. Keep picker and backend validation in sync.
const extensions: Record<string, AssistantAttachment['kind']> = {};
for (const extension of 'mp4 mkv mov avi webm m4v flv wmv mpg mpeg mpe ts mts m2ts vob ogv 3gp 3g2 mxf'.split(
  ' ',
))
  extensions[extension] = 'video';
for (const extension of 'mp3 wav wave m4a m4b aac flac ogg oga opus wma aif aiff amr ac3 au caf ape alac'.split(
  ' ',
))
  extensions[extension] = 'audio';
for (const extension of 'srt vtt ass ssa lrc txt md markdown json'.split(' '))
  extensions[extension] = 'file';
for (const extension of 'png jpg jpeg webp gif'.split(' '))
  extensions[extension] = 'image';

export const ASSISTANT_ATTACHMENT_EXTENSIONS = Object.keys(extensions);
export const ASSISTANT_ATTACHMENT_ACCEPT = ASSISTANT_ATTACHMENT_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(',');
export function assistantAttachmentKind(filePath: string) {
  const extension =
    filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';
  return Object.prototype.hasOwnProperty.call(extensions, extension)
    ? extensions[extension]
    : undefined;
}

/** Drop legacy extracted text as well as any non-metadata fields. */
export function assistantAttachmentReference(
  attachment: AssistantAttachment,
): AssistantAttachment {
  const { id, name, path, size } = attachment;
  const kind = assistantAttachmentKind(path) || 'file';
  return {
    id,
    name,
    path,
    size,
    kind,
    ...(kind === 'image' && attachment.kind === 'image'
      ? { imagePath: attachment.imagePath, mimeType: attachment.mimeType }
      : {}),
  };
}
