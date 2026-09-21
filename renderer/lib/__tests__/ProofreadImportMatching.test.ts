import {
  createPendingFileFromSubtitle,
  createPendingFileFromVideo,
} from '../proofreadUtils';

const source = {
  filePath: '/movie.fr.srt',
  type: 'source',
  language: 'fr',
  confidence: 100,
};
const target = {
  filePath: '/movie.en.srt',
  type: 'source',
  language: 'en',
  confidence: 30,
};
const unrelated = { filePath: '/other.srt', type: 'unknown', confidence: 30 };
let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(async (channel: string) => {
    if (channel === 'checkFileExists') return { exists: true };
    if (channel === 'detectLanguage')
      return { success: true, data: { code: 'fr' } };
    if (channel === 'detectSubtitles')
      return {
        success: true,
        data: { detectedSubtitles: [source, target, unrelated] },
      };
    if (channel === 'matchSubtitleFiles')
      return {
        success: true,
        data: [
          {
            baseName: 'movie',
            source: target.filePath,
            target: source.filePath,
          },
          { baseName: 'other', source: unrelated.filePath },
        ],
      };
    throw new Error(channel);
  });
  window.ipc = { invoke } as any;
});

test('filename pairing respects the explicit non-English source despite inferred language roles', async () => {
  const result = await createPendingFileFromSubtitle(source.filePath, true, {
    strict: true,
  });
  expect(result.selectedSource).toBe(source.filePath);
  expect(result.selectedTarget).toBe(target.filePath);
  expect(result.detectedSubtitles).toContainEqual(unrelated);
});

test('unrelated directory neighbors are offered but never selected automatically', async () => {
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'matchSubtitleFiles'
      ? Promise.resolve({
          success: true,
          data: [
            { baseName: 'movie', source: source.filePath },
            { baseName: 'other', source: unrelated.filePath },
          ],
        })
      : normal(channel, payload),
  );
  expect(
    (
      await createPendingFileFromSubtitle(source.filePath, true, {
        strict: true,
      })
    ).selectedTarget,
  ).toBeUndefined();
  invoke.mockImplementation((channel, payload) =>
    channel === 'detectSubtitles'
      ? Promise.resolve({
          success: true,
          data: { detectedSubtitles: [unrelated] },
        })
      : normal(channel, payload),
  );
  const video = await createPendingFileFromVideo('/video.mp4', {
    strict: true,
  });
  expect(video.selectedSource).toBeUndefined();
  expect(video.selectedTarget).toBeUndefined();
  expect(video.detectedSubtitles).toEqual([unrelated]);
});

test.each([
  { success: false, error: 'Matching failed' },
  { success: true, data: null },
])('strict imports reject invalid matching responses: %j', async (response) => {
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((channel, payload) =>
    channel === 'matchSubtitleFiles'
      ? Promise.resolve(response)
      : normal(channel, payload),
  );
  await expect(
    createPendingFileFromSubtitle(source.filePath, true, { strict: true }),
  ).rejects.toThrow();
});
