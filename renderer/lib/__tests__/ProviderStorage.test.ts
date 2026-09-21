import {
  getAsrProviders,
  setAsrProviders,
} from '../../../main/helpers/asrProviderManager';
import {
  getTtsProviders,
  setTtsProviders,
} from '../../../main/helpers/ttsProviderManager';
import { getAndInitializeProviders } from '../../../main/helpers/providerManager';
import { store } from '../../../main/helpers/store';

jest.mock('../../../main/helpers/store', () => ({
  store: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('../../../main/helpers/logger', () => ({ logMessage: jest.fn() }));

beforeEach(() => jest.resetAllMocks());

test.each([getAsrProviders, getTtsProviders, getAndInitializeProviders])(
  'corrupt stored lists fail without replacing user data (%p)',
  async (read) => {
    for (const value of [null, {}, [null], [{ id: 'one' }]]) {
      (store.get as jest.Mock).mockReturnValue(value);
      await expect(
        Promise.resolve().then(async () => {
          await read();
        }),
      ).rejects.toThrow('INVALID_PROVIDER_LIST');
      expect(store.set).not.toHaveBeenCalled();
    }
  },
);

test.each([
  [getAsrProviders, setAsrProviders],
  [getTtsProviders, setTtsProviders],
])(
  'missing cloud lists are empty but failed writes are never acknowledged (%p)',
  async (read, write) => {
    expect(read()).toEqual([]);
    const failure = new Error('EACCES');
    (store.set as jest.Mock).mockImplementation(() => {
      throw failure;
    });
    expect(() => write!([])).toThrow(failure);
  },
);

test('translation initialization and migration surface real write failures', async () => {
  (store.set as jest.Mock).mockImplementation(() => {
    throw new Error('EACCES');
  });
  await expect(getAndInitializeProviders()).rejects.toThrow('EACCES');
  (store.get as jest.Mock).mockImplementation((key) =>
    key === 'translationProviders'
      ? [{ id: 'custom', type: 'openai', name: 'Keep me', apiKey: 'fixture' }]
      : 1,
  );
  await expect(getAndInitializeProviders()).rejects.toThrow('EACCES');
});
