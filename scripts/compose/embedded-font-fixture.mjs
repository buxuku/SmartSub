import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function embeddedFontFixture() {
  const directory = path.join(
    path.dirname(require.resolve('playwright-core/package.json')),
    'lib/vite/recorder/assets',
  );
  const file = fs
    .readdirSync(directory)
    .find((file) => /^codicon-.*\.ttf$/.test(file));
  if (!file) throw new Error('Playwright test font not found');
  return fs.readFileSync(path.join(directory, file));
}

export function encodeAssFont(data) {
  let encoded = '';
  for (let offset = 0; offset < data.length; offset += 3) {
    const remaining = Math.min(3, data.length - offset);
    const value =
      data[offset] * 65536 +
      (data[offset + 1] || 0) * 256 +
      (data[offset + 2] || 0);
    for (let i = 0; i < remaining + 1; i++)
      encoded += String.fromCharCode(((value >>> (18 - i * 6)) & 63) + 33);
  }
  return encoded.match(/.{1,80}/g).join('\n');
}

export const fontSection = (data, name = 'fixture.ttf') =>
  `\n[Fonts]\nfontname: ${name}\n${encodeAssFont(data)}\n`;
