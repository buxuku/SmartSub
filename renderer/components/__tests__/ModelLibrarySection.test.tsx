import { act, render, screen } from '@testing-library/react';
import ModelLibrarySection from '../resources/ModelLibrarySection';

// Strings come from the real English files, so a missing key fails here instead
// of showing the user a bare key. `t` keeps one identity per namespace, as the
// real hook does, so effects that depend on it do not re-run on every render.
jest.mock('next-i18next', () => {
  const translators: Record<string, (key: string) => string> = {};
  const translatorFor = (namespace: string) => {
    if (!translators[namespace]) {
      let strings: Record<string, unknown> = {};
      try {
        strings = require(`../../public/locales/en/${namespace}.json`);
      } catch {
        // A namespace without a file renders its keys, like next-i18next does.
      }
      translators[namespace] = (key) => String(strings[key] ?? key);
    }
    return translators[namespace];
  };
  return {
    useTranslation: (namespace = 'common') => ({ t: translatorFor(namespace) }),
  };
});
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

const CT2_PATH = '/data/ct2-models';
const GGML_PATH = '/data/ggml-models';

const systemInfo = {
  totalMemoryGB: 16,
  modelsInstalled: [],
  downloadingModels: [],
  fasterWhisperModelsInstalled: [],
  fasterWhisperModelsPath: CT2_PATH,
  modelsPath: GGML_PATH,
  modelPathSources: { ct2: 'override', ggml: 'default' },
  storageRoot: '',
} as any;

/** Renders and lets the row actions finish loading their download endpoints. */
async function renderSection(engine: 'fasterWhisper' | 'builtin') {
  window.ipc = {
    invoke: jest.fn(async () => undefined),
    on: jest.fn(() => jest.fn()),
  } as any;
  await act(async () => {
    render(
      <ModelLibrarySection
        engine={engine}
        systemInfo={systemInfo}
        systemInfoLoaded
        globalDownloading={false}
        onUpdate={jest.fn()}
      />,
    );
  });
}

const SHARED_CACHE_HINT = /choose the folder that contains hub/i;

test('the faster-whisper path row says which folder to pick to share a HuggingFace cache', async () => {
  await renderSection('fasterWhisper');

  // The row itself renders, so a missing hint is the only thing that can fail.
  expect(screen.getByText(CT2_PATH)).toBeInTheDocument();
  expect(screen.getByText(SHARED_CACHE_HINT)).toBeInTheDocument();
});

test('other engines do not get the faster-whisper hint', async () => {
  await renderSection('builtin');

  expect(screen.getByText(GGML_PATH)).toBeInTheDocument();
  expect(screen.queryByText(SHARED_CACHE_HINT)).not.toBeInTheDocument();
});
