import { act, fireEvent, render, screen } from '@testing-library/react';
import EmbeddedSubtitleControl from '../tasks/EmbeddedSubtitleControl';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const SWITCH = 'configBar.embeddedSubtitles';
const PROMPT = 'embeddedSubtitleSetting.promptLabel';

type Handler = (channel: string, payload?: any) => unknown;
let writes: Array<Record<string, unknown>>;

function installIpc(handler: Handler = () => ({})) {
  writes = [];
  window.ipc = {
    invoke: jest.fn(async (channel: string, payload?: any) => {
      if (channel === 'setSettings') writes.push(payload);
      return handler(channel, payload);
    }),
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  } as any;
}
const settingsOf =
  (settings: Record<string, unknown>, onWrite?: Handler): Handler =>
  (channel, payload) =>
    channel === 'getSettings' ? settings : onWrite?.(channel, payload);

async function mount(props: { enabled?: boolean; onChange?: jest.Mock } = {}) {
  const onChange = props.onChange ?? jest.fn();
  const view = render(
    <EmbeddedSubtitleControl
      enabled={props.enabled ?? true}
      onEnabledChange={onChange}
    />,
  );
  await act(async () => {});
  return { ...view, onChange };
}
const prompt = () => screen.getByRole('checkbox', { name: PROMPT });
const tick = async (label: string = PROMPT) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: label }));
  });
};

describe('the task-level switch', () => {
  beforeEach(() => installIpc(settingsOf({})));

  test.each([true, false])('shows %s as it is given', async (enabled) => {
    await mount({ enabled });
    expect(screen.getByRole('switch', { name: SWITCH })).toHaveAttribute(
      'aria-checked',
      String(enabled),
    );
  });

  test('reports a change to the task and writes no setting', async () => {
    const { onChange } = await mount({ enabled: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: SWITCH }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(writes).toEqual([]);
  });

  test('explains what it does', async () => {
    await mount();
    expect(
      screen.getByText('embeddedSubtitleSetting.description'),
    ).toBeVisible();
  });
});

describe('asking before a start', () => {
  test('is on for a fresh install', async () => {
    installIpc(settingsOf({}));
    await mount();
    expect(prompt()).toBeChecked();
    expect(prompt()).toBeEnabled();
  });

  test('shows the preference that was stored, such as the dialog\'s "don\'t ask again"', async () => {
    installIpc(settingsOf({ embeddedSubtitlePrompt: false }));
    await mount();
    expect(prompt()).not.toBeChecked();
  });

  test('is inert until the stored preference has been read, and never writes on mount', async () => {
    let release!: (settings: Record<string, unknown>) => void;
    installIpc((channel) =>
      channel === 'getSettings'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    await mount();
    expect(prompt()).toBeDisabled();
    await act(async () => release({ embeddedSubtitlePrompt: false }));
    expect(prompt()).toBeEnabled();
    expect(prompt()).not.toBeChecked();
    expect(writes).toEqual([]);
  });

  test('behaves like a fresh install when the settings cannot be read', async () => {
    installIpc((channel) => {
      if (channel === 'getSettings') throw new Error('EIO');
    });
    await mount();
    expect(prompt()).toBeChecked();
    expect(prompt()).toBeEnabled();
  });

  test('turning it off and on again is stored each time', async () => {
    installIpc(settingsOf({}));
    await mount();
    await tick();
    expect(prompt()).not.toBeChecked();
    await tick();
    expect(prompt()).toBeChecked();
    expect(writes).toEqual([
      { embeddedSubtitlePrompt: false },
      { embeddedSubtitlePrompt: true },
    ]);
  });

  test('writes only its own key', async () => {
    installIpc(settingsOf({ useVAD: true, cloudUploadConsent: true }));
    await mount();
    await tick();
    expect(writes).toEqual([{ embeddedSubtitlePrompt: false }]);
  });

  test.each([
    [
      'the write throws',
      () => {
        throw new Error('EACCES');
      },
    ],
    ['the write is refused', () => ({ success: false, error: 'EACCES' })],
  ])('goes back to the stored value when %s', async (_name, onWrite) => {
    installIpc(settingsOf({}, (channel) => onWrite()));
    await mount();
    await tick();
    expect(prompt()).toBeChecked();
  });

  test('a late failure does not undo a newer change', async () => {
    const failures: Array<() => void> = [];
    let writesSeen = 0;
    installIpc(
      settingsOf({}, () => {
        writesSeen += 1;
        if (writesSeen === 1)
          return new Promise((_, reject) => {
            failures.push(() => reject(new Error('EACCES')));
          });
        return { rejectedKeys: [] };
      }),
    );
    await mount();
    await tick(); // off: this write is still in flight
    await tick(); // on again: stored at once
    await tick(); // off once more: the latest word
    // The first write fails now. Rolling back to what it replaced would show "on",
    // which is neither the stored value nor what the user last chose.
    await act(async () => failures[0]());
    expect(prompt()).not.toBeChecked();
    expect(writes).toEqual([
      { embeddedSubtitlePrompt: false },
      { embeddedSubtitlePrompt: true },
      { embeddedSubtitlePrompt: false },
    ]);
  });

  test('is moot, and shown as such, while recognition is forced', async () => {
    installIpc(settingsOf({ embeddedSubtitlePrompt: false }));
    await mount({ enabled: false });
    expect(prompt()).toBeDisabled();
    expect(prompt()).not.toBeChecked();
    expect(writes).toEqual([]);
  });

  test('comes back to life when the switch is turned on', async () => {
    installIpc(settingsOf({}));
    const view = await mount({ enabled: false });
    expect(prompt()).toBeDisabled();
    view.rerender(
      <EmbeddedSubtitleControl enabled onEnabledChange={view.onChange} />,
    );
    expect(prompt()).toBeEnabled();
    expect(prompt()).toBeChecked();
  });
});
