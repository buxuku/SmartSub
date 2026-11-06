const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const loader = require('./lib/load-typescript.cjs');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-cookie-batch-'));
  try {
    let settings = {};
    let failCommit = false;
    let failWrite = false;
    let failClear = false;
    let exportText = '';
    let extractionError = '';
    let extractionCalls = 0;
    let exportPath;
    const load = loader({
      process: { platform: 'darwin', env: {} },
      os: { ...os, homedir: () => path.join(dir, 'home') },
      fs: {
        ...fs,
        rmSync(file, options) {
          if (failClear && file === path.join(dir, 'downloader-cookies'))
            throw new Error('permission denied');
          return fs.rmSync(file, options);
        },
        writeFileSync(file, ...args) {
          if (failWrite && String(file).includes('youtube'))
            throw new Error('disk full');
          return fs.writeFileSync(file, ...args);
        },
      },
      electron: {
        app: { getPath: () => dir },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from(`encrypted:${text}`),
          decryptString: (buffer) => {
            assert.ok(buffer.toString().startsWith('encrypted:'));
            return buffer.toString().slice('encrypted:'.length);
          },
        },
      },
      '../storeManager': {
        store: {
          get: () => settings,
          set: (_key, value) => {
            if (failCommit) throw new Error('settings commit failed');
            settings = value;
          },
        },
        logMessage() {},
      },
      '../downloaderManager': { getDownloaderBinaryPath: () => '/yt-dlp' },
      './engineAdapter': {
        async runProcess(_binary, args) {
          extractionCalls++;
          exportPath = args[args.indexOf('--cookies') + 1];
          fs.writeFileSync(exportPath, exportText);
          return {
            code: 1,
            stdout: 'Extracted cookies',
            stderr:
              extractionError || 'ERROR: [generic] 127.0.0: Connection refused',
          };
        },
      },
    });
    const store = load('main/helpers/videoDownload/cookieProfileStore.ts');
    const imports = load('main/helpers/videoDownload/cookieImport.ts');
    const { parseNetscapeCookies: parse } = load(
      'main/helpers/videoDownload/cookies.ts',
    );
    const cookie = (domain, name = 'session', value = 'fixture') =>
      `${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}\n`;

    // Legacy files and user-defined sites survive the new storage format.
    const customId = `custom-${randomUUID()}`;
    fs.mkdirSync(path.join(dir, 'downloader-cookies'));
    fs.writeFileSync(
      path.join(dir, 'downloader-cookies', `${customId}.cookies`),
      cookie('.example.video'),
    );
    settings = {
      videoDownloadCookieProfiles: [
        {
          id: customId,
          kind: 'custom',
          name: 'My video site',
          matchDomains: ['example.video'],
          cookieDomains: ['example.video'],
          importedAt: 1,
          source: 'file',
          encrypted: false,
        },
      ],
    };
    assert.match(
      store.resolveCookieTextForUrl('https://example.video/1'),
      /fixture/,
    );
    assert.equal(
      typeof store.importCookiesForSites,
      'function',
      'batch import saves recognized sites without a domain input',
    );

    const text =
      cookie('.douyin.com', 'sessionid') +
      cookie('www.douyin.com', 'web') +
      cookie('.bilibili.com', 'SESSDATA') +
      cookie('.youtube.com', 'LOGIN_INFO') +
      cookie('.example.video') +
      cookie('.mail.example.com') +
      cookie('.google.com', 'mail_session') +
      cookie('.douyin.com.evil.test') +
      cookie('.xiaohongshu.com', 'web_session');
    const first = store.importCookiesForSites({
      cookies: parse(text),
      source: 'browser',
      browser: 'chrome',
      browserProfile: 'Default',
    });
    assert.deepEqual(
      Array.from(first.profiles, (p) => p.id).sort(),
      ['bilibili', customId, 'douyin', 'xiaohongshu', 'youtube'].sort(),
    );
    assert.equal(first.cookieCount, 6);
    assert.equal(first.ignoredCookieCount, 3);
    assert.equal(
      first.profiles.find((p) => p.id === 'douyin').browserProfile,
      'Default',
    );
    assert.equal(first.profiles.find((p) => p.id === 'douyin').encrypted, true);
    for (const [url, included, excluded] of [
      [
        'https://v.douyin.com/short',
        /sessionid/,
        /LOGIN_INFO|mail_session|SESSDATA|evil/,
      ],
      ['https://b23.tv/short', /SESSDATA/, /sessionid|LOGIN_INFO/],
      ['https://youtu.be/short', /LOGIN_INFO/, /mail_session|SESSDATA/],
      ['https://xhslink.com/short', /web_session/, /sessionid/],
    ]) {
      assert.match(store.resolveCookieTextForUrl(url), included);
      assert.doesNotMatch(store.resolveCookieTextForUrl(url), excluded);
    }
    assert.equal(
      store.resolveCookieTextForUrl('https://mail.example.com'),
      null,
    );
    assert.equal(
      store.resolveCookieTextForUrl('https://douyin.com.evil.test'),
      null,
    );
    assert.equal(store.resolveCookieTextForUrl('https://google.com'), null);
    assert.equal(
      fs.existsSync(
        path.join(dir, 'downloader-cookies', `${customId}.cookies`),
      ),
      false,
      'old content removed after a successful replacement',
    );

    store.importCookiesForSites({
      cookies: parse(cookie('.douyin.com', 'replacement', 'second-account')),
      source: 'browser',
      browser: 'edge',
      browserProfile: 'Profile 1',
    });
    assert.doesNotMatch(
      store.resolveCookieTextForUrl('https://douyin.com/video/1'),
      /sessionid|web\t/,
    );
    assert.match(
      store.resolveCookieTextForUrl('https://douyin.com/video/1'),
      /second-account/,
    );
    assert.match(
      store.resolveCookieTextForUrl('https://youtu.be/a'),
      /LOGIN_INFO/,
      'unmatched old sites are preserved',
    );
    const before = JSON.stringify(settings);
    const files = fs.readdirSync(path.join(dir, 'downloader-cookies')).sort();
    for (const failure of ['write', 'commit']) {
      failWrite = failure === 'write';
      failCommit = failure === 'commit';
      assert.throws(
        () =>
          store.importCookiesForSites({ cookies: parse(text), source: 'file' }),
        /disk full|settings commit failed/,
      );
      failWrite = failCommit = false;
      assert.equal(
        JSON.stringify(settings),
        before,
        'batch failure cannot publish partial metadata',
      );
      assert.deepEqual(
        fs.readdirSync(path.join(dir, 'downloader-cookies')).sort(),
        files,
        'failed batch removes staged contents',
      );
      assert.match(
        store.resolveCookieTextForUrl('https://douyin.com/1'),
        /second-account/,
      );
    }
    assert.throws(
      () =>
        store.importCookiesForSites({
          cookies: parse(cookie('.mail.example.com')),
          source: 'file',
        }),
      /NO_SUPPORTED_SITE_COOKIES/,
    );
    assert.equal(JSON.stringify(settings), before);

    exportText = text;
    const bulk = await imports.importAllCookiesFromBrowser({
      browser: 'firefox',
    });
    assert.equal(
      extractionCalls,
      1,
      'one extraction populates every matching site',
    );
    assert.equal(bulk.profiles.length, 5);
    assert.equal(fs.existsSync(path.dirname(exportPath)), false);
    const beforeExtractFailure = JSON.stringify(settings);
    for (const output of [
      'WARNING: failed to decrypt cookies',
      'Extracted 30 cookies from chrome (2 could not be decrypted)',
      'WARNING: unknown cookie version: "v99"',
    ]) {
      extractionError = output;
      await assert.rejects(
        imports.importAllCookiesFromBrowser({ browser: 'firefox' }),
        /BROWSER_COOKIE_DECRYPT_FAILED/,
        'partial cookie exports must not replace working profiles',
      );
    }
    assert.equal(JSON.stringify(settings), beforeExtractFailure);
    assert.equal(fs.existsSync(path.dirname(exportPath)), false);
    await assert.rejects(
      imports.importAllCookiesFromBrowser({ browser: '--bad' }),
      /Unsupported browser/,
    );
    extractionError = '';
    exportText = cookie('.mail.example.com');
    await assert.rejects(
      imports.importAllCookiesFromBrowser({ browser: 'firefox' }),
      /NO_SUPPORTED_SITE_COOKIES/,
    );
    assert.equal(fs.existsSync(path.dirname(exportPath)), false);
    assert.equal(JSON.stringify(settings), beforeExtractFailure);
    const source = path.join(dir, 'input.txt');
    fs.writeFileSync(source, cookie('.douyin.com'));
    assert.equal(
      imports.importAllCookiesFromFile({ filePath: source }).profiles[0].id,
      'douyin',
    );
    assert.equal(
      fs.existsSync(source),
      true,
      'file import leaves the original file alone',
    );

    // A legacy custom Douyin entry should become the built-in site when refreshed,
    // otherwise a narrower stale custom match can silently override the new account.
    const legacyDouyin = `custom-${randomUUID()}`;
    store.importCookiesToProfile({
      id: legacyDouyin,
      cookies: parse(cookie('.douyin.com', 'legacy_account')),
      source: 'file',
      customDef: {
        name: 'Douyin custom',
        matchDomains: ['www.douyin.com'],
        cookieDomains: ['www.douyin.com'],
      },
    });
    store.importCookiesForSites({
      cookies: parse(cookie('.douyin.com', 'fresh_account')),
      source: 'file',
    });
    assert.equal(
      store.listCookieProfiles().some((p) => p.id === legacyDouyin),
      false,
      'a custom entry wholly covered by the refreshed preset is consolidated',
    );
    assert.match(
      store.resolveCookieTextForUrl('https://www.douyin.com/video/1'),
      /fresh_account/,
    );
    assert.equal(
      store.listCookieProfiles().some((p) => p.id === customId),
      true,
      'unrelated custom sites stay intact',
    );
    store.importCookiesToProfile({
      id: legacyDouyin,
      cookies: parse(cookie('.douyin.com', 'manually_selected_account')),
      source: 'file',
      customDef: {
        name: 'Another account',
        matchDomains: ['douyin.com'],
        cookieDomains: ['douyin.com'],
      },
    });
    assert.match(
      store.resolveCookieTextForUrl('https://www.douyin.com/video/1'),
      /manually_selected_account/,
      'equal-domain matches honor the latest explicit import',
    );
    const scopedText =
      cookie('.douyin.com', 'public_session') +
      'creator.douyin.com\tFALSE\t/\tTRUE\t0\tadmin_session\tprivate\n' +
      cookie('.creator.douyin.com', 'admin_domain_session') +
      cookie('www.douyin.com', 'public_web');
    const scopedImport = store.importCookiesForSites({
      cookies: parse(scopedText),
      source: 'file',
    });
    assert.equal(
      scopedImport.cookieCount,
      2,
      'automatic site import excludes sibling administration hosts',
    );
    assert.equal(scopedImport.ignoredCookieCount, 2);
    assert.doesNotMatch(
      store.resolveCookieTextForUrl('https://www.douyin.com/video/1'),
      /admin_/,
    );

    const browserRoot = path.join(
      dir,
      'home/Library/Application Support/Google/Chrome',
    );
    for (const profile of [
      'Default',
      'Profile 1',
      'Default/Storage/ext/glic/internal',
    ]) {
      fs.mkdirSync(path.join(browserRoot, profile), { recursive: true });
      fs.writeFileSync(path.join(browserRoot, profile, 'Cookies'), profile);
    }
    fs.writeFileSync(
      path.join(browserRoot, 'Local State'),
      JSON.stringify({
        profile: {
          last_used: 'Default',
          info_cache: {
            Default: { name: 'Personal' },
            'Profile 1': { name: 'Work' },
          },
        },
      }),
    );
    const browserSource = load(
      'main/helpers/videoDownload/browserCookieSource.ts',
    );
    assert.deepEqual(
      Array.from(browserSource.listBrowserCookieProfiles('chrome'), (p) => [
        p.id,
        p.name,
        p.isDefault,
      ]),
      [
        ['Default', 'Personal', true],
        ['Profile 1', 'Work', false],
      ],
    );
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    const selected = browserSource.prepareBrowserCookieSource(
      'chrome',
      staging,
      'Profile 1',
    );
    assert.equal(
      fs.readFileSync(
        path.join(selected.slice('chrome:'.length), 'Cookies'),
        'utf8',
      ),
      'Profile 1',
    );
    for (const profile of [
      '../Default',
      '/tmp',
      'Default/Storage/ext/glic/internal',
      'Missing',
    ]) {
      assert.throws(
        () =>
          browserSource.prepareBrowserCookieSource('chrome', staging, profile),
        /BROWSER_PROFILE_NOT_FOUND/,
      );
    }
    const cookieDir = path.join(dir, 'downloader-cookies');
    const browserDatabase = path.join(browserRoot, 'Default', 'Cookies');
    assert.equal(store.deleteCookieProfile('douyin'), true);
    assert.equal(
      store.resolveCookieTextForUrl('https://www.douyin.com/1'),
      null,
    );
    assert.match(
      store.resolveCookieTextForUrl('https://youtu.be/1'),
      /LOGIN_INFO/,
      'clearing one site does not delete other sites',
    );
    assert.equal(
      typeof store.clearCookieProfiles,
      'function',
      'clear all has a dedicated store operation',
    );
    failClear = true;
    const beforeClear = JSON.stringify(settings);
    assert.throws(() => store.clearCookieProfiles(), /permission denied/);
    assert.equal(JSON.stringify(settings), beforeClear);
    assert.match(
      store.resolveCookieTextForUrl('https://youtu.be/1'),
      /LOGIN_INFO/,
    );
    failClear = false;
    fs.writeFileSync(
      path.join(cookieDir, 'orphan.cookies'),
      'leftover content',
    );
    store.clearCookieProfiles();
    assert.equal(settings.videoDownloadCookieProfiles.length, 0);
    assert.equal(
      store.listCookieProfiles().some((p) => p.configured || p.needsReimport),
      false,
    );
    assert.equal(store.resolveCookieTextForUrl('https://youtu.be/1'), null);
    assert.equal(
      fs.existsSync(cookieDir),
      false,
      'clear all removes stored and orphaned cookie files',
    );
    assert.equal(
      fs.readFileSync(browserDatabase, 'utf8'),
      'Default',
      'browser source data is never cleared',
    );
    store.clearCookieProfiles();
    assert.equal(
      imports.importAllCookiesFromFile({ filePath: source }).profiles[0].id,
      'douyin',
      'import remains usable after clear all',
    );
    console.log(
      'Cookie batch import: classification, aliases, isolation, legacy compatibility, replacement, atomic failure, extraction cleanup, profile selection and site/all clearing passed.',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
