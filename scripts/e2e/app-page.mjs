import assert from 'node:assert/strict';

/** Accept both Nextron's dev server and the exported Electron renderer. */
export const appPageUrl = /^(?:http:\/\/localhost:\d+|app:\/\/\.)\//;

export async function waitForAppPage(page) {
  await page.waitForURL(appPageUrl);
  if (process.argv.includes('--production'))
    assert.equal(
      new URL(page.url()).protocol,
      'app:',
      'Run npm run build before production E2E',
    );
}

export function appOrigin(page) {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
}
