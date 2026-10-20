/**
 * What a brand-new install gets, read from the real factory defaults instead of restated:
 * "Prefer embedded subtitles" is on and nothing has been remembered yet, so the first start
 * of a video that carries subtitles asks. Changing either default has to be deliberate.
 */
import { defaultUserConfig } from '../../../main/helpers/utils';
import { shouldUseEmbeddedSubtitles } from '../../../main/helpers/embeddedSubtitleParser';
import '../../../main/helpers/store';
import { findEmbeddedSubtitleHit } from '../embeddedSubtitleScan';

jest.mock('electron', () => ({ app: {} }));
// The store builds its factory defaults when it is first loaded: capture them instead of
// opening a real config file.
jest.mock('electron-store', () => {
  const created: Array<{ defaults: Record<string, any> }> = [];
  return {
    __esModule: true,
    created,
    default: class {
      constructor(options: { defaults: Record<string, any> }) {
        created.push(options);
      }
    },
  };
});

const factory = (): { userConfig: any; settings: any } =>
  (
    jest.requireMock('electron-store') as {
      created: Array<{ defaults: any }>;
    }
  ).created[0].defaults;

describe('a new install', () => {
  test('prefers the embedded subtitles', () => {
    expect(defaultUserConfig.useEmbeddedSubtitles).toBe(true);
    expect(factory().userConfig.useEmbeddedSubtitles).toBe(true);
    expect(shouldUseEmbeddedSubtitles(factory().userConfig)).toBe(true);
  });

  test('has not remembered an answer, so the question is on', () => {
    // "Remember my choice" is stored as `embeddedSubtitlePrompt: false`; only the user
    // writes it, so the factory settings must not.
    expect(factory().settings.embeddedSubtitlePrompt).not.toBe(false);
  });

  test('is asked on the first start of a video that carries subtitles', async () => {
    const hit = {
      filePath: '/media/a.mkv',
      tracks: [{ language: 'eng', codec: 'subrip' }],
    };
    window.ipc = {
      invoke: jest.fn(async (channel: string) =>
        channel === 'getSettings'
          ? factory().settings
          : { status: 'found', hit },
      ),
    } as any;

    await expect(
      findEmbeddedSubtitleHit({
        typeDef: { needsModel: true },
        files: [{ filePath: '/media/a.mkv' }],
        formData: factory().userConfig,
      }),
    ).resolves.toEqual(hit);
  });
});
