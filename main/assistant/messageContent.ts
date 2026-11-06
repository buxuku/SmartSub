import fs from 'fs/promises';
import type { ModelMessage } from './protocol';

/** Keep binary image data out of history files, events and the text context budget. */
export async function modelRequestMessages(messages: ModelMessage[]) {
  return Promise.all(
    messages.map(async ({ images, ...message }) =>
      images?.length
        ? {
            ...message,
            content: [
              { type: 'text', text: message.content || '' },
              ...(await Promise.all(
                images.map(async (image) => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mimeType};base64,${(await fs.readFile(image.path)).toString('base64')}`,
                  },
                })),
              )),
            ],
          }
        : message,
    ),
  );
}
