/** @jest-environment node */
import path from 'path';
import { app } from 'electron';
import { getExtraResourcesPath } from '../../helpers/utils';

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/workspace/SmartSub' },
}));

const originalResourcesPath = process.resourcesPath;
const originalMode = process.env.NODE_ENV;
afterEach(() => {
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true,
  });
  process.env.NODE_ENV = originalMode;
});

test.each([
  [false, 'development'],
  [false, 'production'],
  [true, 'production'],
  [true, 'development'],
] as const)(
  'resource layout follows packaged=%s, independently of mode=%s',
  (packaged, mode) => {
    Object.defineProperty(app, 'isPackaged', {
      value: packaged,
      configurable: true,
    });
    Object.defineProperty(process, 'resourcesPath', {
      value: '/installed/Resources',
      configurable: true,
    });
    process.env.NODE_ENV = mode;
    expect(getExtraResourcesPath()).toBe(
      path.join(
        packaged ? '/installed/Resources' : '/workspace/SmartSub',
        'extraResources',
      ),
    );
  },
);
