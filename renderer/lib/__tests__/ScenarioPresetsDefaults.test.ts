/**
 * What a brand-new install shows on the scenario button, computed from the real factory
 * defaults instead of restated: 「通用均衡」 with nothing adjusted.
 *
 * The defaults carry `maxSubtitleChars: 0` and `speakerDiarizationCount: 0` ("let SmartSub
 * decide"). Reading those zeros as changes used to put 「专家自定义」 on the button of every
 * fresh install, so a change to either default, or to the rule, has to be deliberate.
 */
import { defaultUserConfig } from '../../../main/helpers/utils';
import { inferDisplayOutcome } from '../../../types/subtitleOutcome';
import '../../../main/helpers/store';
import {
  detectCurrentPreset,
  getPresetDeviations,
  getScenarioState,
} from '../scenarioPresets';

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

/** What `getUserConfig` hands the task form of a fresh install. */
function freshInstallForm(): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaultUserConfig };
  merged.subtitleOutcome = inferDisplayOutcome(merged, factory().settings);
  return merged;
}

describe('a new install', () => {
  test('still carries the two zero defaults the old rule misread', () => {
    // If these stop being zero the regression below no longer proves anything.
    expect(defaultUserConfig.maxSubtitleChars).toBe(0);
    expect(defaultUserConfig.speakerDiarizationCount).toBe(0);
  });

  test('is on 通用均衡 with nothing adjusted', () => {
    const form = freshInstallForm();
    expect(form.subtitleOutcome).toBe('balanced');
    expect(getPresetDeviations(form)).toEqual([]);
    expect(detectCurrentPreset(form)).toBe('balanced');
    expect(getScenarioState(form)).toMatchObject({
      presetId: 'balanced',
      adjusted: false,
      expertAdjusted: false,
      groups: [],
    });
  });

  test('is still on 通用均衡 when the store has no outcome tier yet', () => {
    // A profile written before the tiers existed carries no subtitleOutcome at all.
    const form = { ...defaultUserConfig };
    expect(getScenarioState(form)).toMatchObject({
      presetId: 'balanced',
      adjusted: false,
    });
  });

  test('is adjusted as soon as one of the two zeros becomes a real value', () => {
    const form = { ...freshInstallForm(), maxSubtitleChars: 28 };
    expect(getScenarioState(form)).toMatchObject({
      presetId: 'balanced',
      adjusted: true,
      groups: ['segmentLength'],
      expertAdjusted: false,
    });
  });
});
