import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  assistantAttachmentKind,
  assistantAttachmentReference,
} from '../../types/assistantAttachments';
import type { AssistantAttachment } from '../../types/assistant';

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Only images are snapshotted; all other supported files remain local path references. */
export class AssistantAttachments {
  constructor(private directory: string) {}
  private filename(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ATTACHMENT');
    return path.join(this.directory, `${id}.json`);
  }
  async import(filePath: string): Promise<AssistantAttachment> {
    if (!path.isAbsolute(filePath)) throw new Error('INVALID_ATTACHMENT_PATH');
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const kind = assistantAttachmentKind(filePath);
    if (!kind) throw new Error('ATTACHMENT_UNSUPPORTED');
    const image = kind === 'image' ? imageTypes[extension] : undefined;
    if (image && stat.size > MAX_IMAGE_BYTES)
      throw new Error('ATTACHMENT_TOO_LARGE');
    const attachment: AssistantAttachment = {
      id: randomUUID(),
      name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      kind,
    };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Subtitles, manuscripts and media are never opened, copied or encoded here.
    if (image) {
      // Bounded reads also protect against a file growing between stat and read.
      const handle = await fs.open(filePath, 'r');
      let buffer: Buffer;
      try {
        const storage = Buffer.alloc(MAX_IMAGE_BYTES + 1);
        let length = 0;
        while (length < storage.length) {
          const { bytesRead } = await handle.read(
            storage,
            length,
            storage.length - length,
            null,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_IMAGE_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
        buffer = storage.subarray(0, length);
      } finally {
        await handle.close();
      }
      attachment.imagePath = path.join(
        this.directory,
        `${attachment.id}.${extension}`,
      );
      attachment.mimeType = image;
      await fs.writeFile(attachment.imagePath, buffer, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    await fs.writeFile(
      this.filename(attachment.id),
      JSON.stringify({ attachment }),
      { mode: 0o600, flag: 'wx' },
    );
    return attachment;
  }
  async saveBuffer(
    buffer: Buffer,
    extension: 'jpeg' | 'png' | 'webp' | 'jpg' = 'jpeg',
    name = `screenshot-${Date.now()}.${extension === 'jpeg' ? 'jpg' : extension}`,
  ): Promise<AssistantAttachment> {
    if (buffer.length > MAX_IMAGE_BYTES)
      throw new Error('ATTACHMENT_TOO_LARGE');
    const ext = extension.toLowerCase();
    const mimeType = imageTypes[ext] || 'image/jpeg';
    const id = randomUUID();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const imagePath = path.join(this.directory, `${id}.${ext}`);
    await fs.writeFile(imagePath, buffer, { mode: 0o600, flag: 'wx' });
    const attachment: AssistantAttachment = {
      id,
      name,
      path: imagePath,
      size: buffer.length,
      kind: 'image',
      imagePath,
      mimeType,
    };
    await fs.writeFile(this.filename(id), JSON.stringify({ attachment }), {
      mode: 0o600,
      flag: 'wx',
    });
    return attachment;
  }
  async get(id: string): Promise<AssistantAttachment> {
    const { attachment } = JSON.parse(
      await fs.readFile(this.filename(id), 'utf8'),
    );
    if (!assistantAttachmentKind(attachment.path))
      throw new Error('ATTACHMENT_UNSUPPORTED');
    return assistantAttachmentReference(attachment);
  }
}
