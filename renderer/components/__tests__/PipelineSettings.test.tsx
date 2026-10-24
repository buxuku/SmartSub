import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  DubbingSettings,
  ComposeSettings,
  ReviewSettings,
} from '../tasks/settings/PipelineSettings';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../dubbing/DubbingLanguageSelect', () => ({
  __esModule: true,
  default: ({ value, disabled, onChange }: any) => (
    <select
      aria-label="ttsLanguage"
      value={value || 'auto'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="auto">auto</option>
      <option value="ja">ja</option>
    </select>
  ),
}));
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  const Context = React.createContext({});
  return {
    Select: ({ value, onValueChange, disabled, children }: any) => (
      <Context.Provider value={{ value, onValueChange, disabled }}>
        {children}
      </Context.Provider>
    ),
    SelectTrigger: ({ children, ...props }: any) => {
      const { value, disabled } = React.useContext(Context);
      return (
        <button type="button" role="combobox" disabled={disabled} {...props}>
          {value}
          {children}
        </button>
      );
    },
    SelectValue: () => null,
    SelectContent: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ value, children, disabled }: any) => {
      const context = React.useContext(Context);
      return (
        <button
          type="button"
          role="option"
          disabled={disabled || context.disabled}
          onClick={() => context.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

const engines: any[] = [
  {
    key: 'cloud:p',
    label: 'Provider',
    kind: 'cloud',
    ready: true,
    voices: [
      { id: 'a', label: 'Alice' },
      { id: 'b', label: 'Bob' },
    ],
  },
];
const options: any = {
  styles: [],
  hwInfo: { available: false },
  preferences: {},
  loaded: true,
  error: false,
};

test('voice edits preserve speed and advanced options; missing selections stay visible', () => {
  const onChange = jest.fn();
  const value: any = {
    engine: { kind: 'cloud', providerId: 'p' },
    voice: 'a',
    globalSpeed: 1.25,
    overflow: 'shift',
    overlapMode: 'mix',
  };
  const view = render(
    <DubbingSettings
      value={value}
      onChange={onChange}
      engines={engines}
      subtitleLanguage="en"
    />,
  );
  fireEvent.click(screen.getByRole('option', { name: 'Bob' }));
  expect(onChange).toHaveBeenCalledWith({ ...value, voice: 'b' });
  view.rerender(
    <DubbingSettings
      value={{ ...value, voice: 'deleted' }}
      onChange={onChange}
      engines={engines}
      subtitleLanguage="en"
    />,
  );
  expect(
    screen.getByRole('combobox', { name: 'wizard.dubVoice' }),
  ).toHaveTextContent('deleted');
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('composition changes keep the resolved style snapshot', () => {
  const onChange = jest.fn();
  const value: any = {
    subtitle: 'hard',
    styleId: 'deleted',
    styleName: 'Old style',
    style: { fontName: 'Saved' },
    encoderMode: 'hardware',
    videoQuality: 'original',
  };
  render(
    <ComposeSettings
      value={value}
      onChange={onChange}
      options={options}
      dubEnabled
      translateOn
      translateContent="onlyTranslate"
    />,
  );
  fireEvent.click(screen.getByRole('option', { name: 'videoQualityHigh' }));
  expect(onChange).toHaveBeenCalledWith({ ...value, videoQuality: 'high' });
  expect(
    screen.getByRole('combobox', { name: 'wizard.composeEncoder' }),
  ).toHaveTextContent('hardware');
});

test('all settings and checkpoint controls are disabled during processing', () => {
  const onChange = jest.fn();
  render(
    <>
      <DubbingSettings
        value={{
          engine: { kind: 'cloud', providerId: 'p' },
          voice: 'a',
          globalSpeed: 1,
        }}
        engines={engines}
        subtitleLanguage="en"
        onChange={onChange}
        disabled
      />
      <ComposeSettings
        value={{ subtitle: 'hard' }}
        options={options}
        onChange={onChange}
        dubEnabled
        translateOn={false}
        disabled
      />
      <ReviewSettings
        value={{ subtitle: 'manual', dubbing: 'auto' }}
        dubEnabled
        onChange={onChange}
        disabled
      />
    </>,
  );
  for (const control of screen.getAllByRole('combobox'))
    expect(control).toBeDisabled();
  for (const control of screen.getAllByRole('switch'))
    expect(control).toBeDisabled();
  fireEvent.click(screen.getByRole('option', { name: 'Bob' }));
  expect(onChange).not.toHaveBeenCalled();
});
