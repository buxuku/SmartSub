import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import ScenarioPresetControl from '../tasks/ScenarioPresetControl';
import { defaultUserConfig } from '../../../main/helpers/utils';

/**
 * The scenario is the one way ordinary users say what the video is. Whatever they change by
 * hand afterwards keeps its name and only adds a dot; 「自定义」 is left for the 手动调节 tier.
 *
 * The test reads what the user reads: the real zh copy, the real factory defaults and a real
 * form. Radix's popover is replaced by a plain open / closed box (its layout and dismissal
 * are exercised by the task page e2e).
 */
jest.mock('electron', () => ({ app: {} }));
jest.mock('next-i18next', () => {
  const i18next = jest.requireActual('i18next');
  const zh = i18next.createInstance();
  zh.init({
    lng: 'zh',
    ns: ['tasks'],
    defaultNS: 'tasks',
    resources: {
      zh: { tasks: jest.requireActual('../../public/locales/zh/tasks.json') },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  return { useTranslation: () => ({ t: zh.getFixedT('zh', 'tasks') }) };
});
jest.mock('@/components/ui/popover', () => {
  const React = require('react');
  const Context = React.createContext({});
  return {
    Popover: ({ open, onOpenChange, children }: any) => (
      <Context.Provider value={{ open, onOpenChange }}>
        {children}
      </Context.Provider>
    ),
    PopoverTrigger: ({ children }: any) => {
      const { open, onOpenChange } = React.useContext(Context);
      return React.cloneElement(children, {
        onClick: () => onOpenChange(!open),
      });
    },
    PopoverContent: ({ children }: any) => {
      const { open } = React.useContext(Context);
      return open ? <div role="dialog">{children}</div> : null;
    },
  };
});

/** What `getUserConfig` hands the form of a fresh install. */
const FRESH = { ...defaultUserConfig, subtitleOutcome: 'balanced' };

let form: ReturnType<typeof useForm<any>>;
const onOpenSettings = jest.fn();

function Harness({ defaults }: { defaults: Record<string, unknown> }) {
  form = useForm({ defaultValues: defaults });
  return (
    <ScenarioPresetControl
      form={form}
      formData={form.watch()}
      onOpenSettings={onOpenSettings}
    />
  );
}

const mount = async (defaults: Record<string, unknown> = FRESH) => {
  render(<Harness defaults={defaults} />);
  await act(async () => {});
};
const trigger = () => screen.getByTestId('scenario-preset-trigger');
const open = async () => {
  await act(async () => {
    fireEvent.click(trigger());
  });
};
const click = async (testId: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
};
const adjustedDot = () => screen.queryByTestId('scenario-adjusted-dot');

describe('the button', () => {
  test('shows 通用均衡 with no dot on a fresh install', async () => {
    await mount();
    expect(trigger()).toHaveTextContent('通用均衡');
    expect(trigger()).not.toHaveTextContent('专家自定义');
    expect(adjustedDot()).toBeNull();
    expect(screen.queryByText('已调整')).toBeNull();
  });

  test('keeps the scenario name and adds a dot once something moved', async () => {
    // Interview was picked, but the form still holds the plain defaults.
    await mount({ ...FRESH, scenarioPreset: 'interview' });
    expect(trigger()).toHaveTextContent('会议访谈 / 播客');
    expect(adjustedDot()).not.toBeNull();
    expect(adjustedDot()).toHaveAttribute('aria-hidden', 'true');
    expect(trigger()).toHaveTextContent('已调整');
    expect(trigger()).not.toHaveTextContent('专家自定义');
  });

  test('shows 自定义 only when 手动调节 was chosen, with no dot', async () => {
    await mount({
      ...FRESH,
      scenarioPreset: 'custom',
      subtitleOutcome: 'custom',
    });
    expect(trigger()).toHaveTextContent('自定义');
    expect(trigger()).not.toHaveTextContent('专家自定义');
    expect(adjustedDot()).toBeNull();
  });
});

describe('the popover', () => {
  test('lists the five scenarios, each with who it suits and what it does', async () => {
    await mount();
    await open();
    const options = screen.getAllByTestId(/^scenario-option-/);
    expect(options.map((o) => o.getAttribute('data-testid'))).toEqual([
      'scenario-option-interview',
      'scenario-option-lecture',
      'scenario-option-movie',
      'scenario-option-shortDrama',
      'scenario-option-balanced',
    ]);
    expect(screen.queryByText('专家自定义')).toBeNull();
    const interview = screen.getByTestId('scenario-option-interview');
    expect(within(interview).getByText('会议访谈 / 播客')).toBeVisible();
    expect(
      within(interview).getByText('多人轮流说话：会议、访谈、播客、对谈'),
    ).toBeVisible();
    expect(within(interview).getByText(/需角色分离模型$/)).toBeInTheDocument();
    expect(screen.getByTestId('scenario-option-balanced')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('choosing a scenario applies it and closes the popover', async () => {
    await mount();
    await open();
    await click('scenario-option-movie');
    expect(form.getValues('scenarioPreset')).toBe('movie');
    expect(form.getValues('subtitleLayout')).toBe('two-line');
    expect(form.getValues('subtitleTranslationStyle')).toBe('conversational');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveTextContent('影视 / Vlog');
    expect(adjustedDot()).toBeNull();
  });

  test('has no scenario ticked after 手动调节, and says why', async () => {
    await mount({
      ...FRESH,
      scenarioPreset: 'custom',
      subtitleOutcome: 'custom',
    });
    await open();
    for (const option of screen.getAllByTestId(/^scenario-option-/))
      expect(option).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('scenario-footer-custom')).toHaveTextContent(
      '当前不再对应任何场景，选一个场景可重置。',
    );
    expect(screen.queryByTestId('scenario-restore')).toBeNull();
  });
});

describe('the footer', () => {
  test('offers nothing to restore while the task is exactly the scenario', async () => {
    await mount();
    await open();
    expect(screen.queryByTestId('scenario-footer-adjusted')).toBeNull();
    expect(screen.queryByTestId('scenario-restore')).toBeNull();
    expect(screen.getByTestId('scenario-open-settings')).toHaveTextContent(
      '更多设置',
    );
    expect(screen.getByTestId('scenario-open-expert')).toHaveTextContent(
      '专家设置',
    );
  });

  test('lists what moved by name, warns that switching resets it, and restores the scenario', async () => {
    await mount();
    await open();
    await click('scenario-option-interview');
    expect(adjustedDot()).toBeNull();

    // The user changes the line length and turns the AI correction on by hand.
    await act(async () => {
      form.setValue('maxSubtitleChars', 40, { shouldDirty: true });
      form.setValue('aiCorrection', true, { shouldDirty: true });
    });
    expect(trigger()).toHaveTextContent('会议访谈 / 播客');
    expect(adjustedDot()).not.toBeNull();

    await open();
    const footer = screen.getByTestId('scenario-footer-adjusted');
    expect(footer).toHaveTextContent(
      '已调整：断句长度、AI 校正。切换场景会重置这些调整。',
    );
    expect(screen.getByTestId('scenario-restore')).toHaveTextContent(
      '恢复为「会议访谈 / 播客」',
    );

    await click('scenario-restore');
    expect(form.getValues('scenarioPreset')).toBe('interview');
    // The interview's own values are back: its line length, and no AI correction (which
    // the scenario never asked for).
    expect(form.getValues('maxSubtitleChars')).toBe(28);
    expect(form.getValues('subtitleMaxDuration')).toBe(3);
    expect(form.getValues('aiCorrection')).toBeUndefined();
    expect(adjustedDot()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('opens 更多设置 on the common page and 专家设置 on the expert page', async () => {
    await mount();
    await open();
    await click('scenario-open-settings');
    expect(onOpenSettings).toHaveBeenLastCalledWith('common');
    expect(screen.queryByRole('dialog')).toBeNull();

    await open();
    await click('scenario-open-expert');
    expect(onOpenSettings).toHaveBeenLastCalledWith('expert');
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });
});
