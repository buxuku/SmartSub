import { correctedSourceSrtSaveOption } from '../../../types/sourceSrtSave';

describe('correctedSourceSrtSaveOption', () => {
  // The factory default is 「不保存」. For a task that only generates subtitles the source
  // subtitle is the deliverable: left on noSave it lands next to the video as `<name>_temp.srt`.
  test.each([undefined, null, '', 'noSave'])(
    'a task that only generates subtitles cannot keep %p: it reads as the video file name',
    (option) => {
      expect(correctedSourceSrtSaveOption('generateOnly', option)).toBe(
        'fileName',
      );
    },
  );

  test.each(['fileName', 'fileNameWithLang', 'custom'])(
    'a task that only generates subtitles keeps its own choice %p',
    (option) => {
      expect(
        correctedSourceSrtSaveOption('generateOnly', option),
      ).toBeUndefined();
    },
  );

  // With a translation the source subtitle is an intermediate: not saving it is the default.
  test.each(['generateAndTranslate', 'translateOnly', 'unknown', undefined])(
    '%p leaves 「不保存」 alone',
    (taskType) => {
      expect(correctedSourceSrtSaveOption(taskType, 'noSave')).toBeUndefined();
      expect(correctedSourceSrtSaveOption(taskType, undefined)).toBeUndefined();
    },
  );
});
