import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import TaskSettingsSheet from '../tasks/TaskSettingsSheet';
import { getTaskTypeBySlug } from '../../lib/taskTypes';
import {
  applyScenarioPreset,
  getScenarioState,
} from '../../lib/scenarioPresets';
import {
  resolveEffectiveSettings,
  TASK_VAD_FIELDS,
} from '../../../types/subtitleOutcome';
import { defaultUserConfig } from '../../../main/helpers/utils';

/**
 * 更多设置 is where the user goes for everything the toolbar does not carry. It has to show
 * what applies to this task and nothing else, put the settings an ordinary user reaches for
 * on 常用 and the ones that need the recognizer's vocabulary on 专家, and never repeat what
 * the toolbar already owns.
 *
 * The test reads what the user reads: the real zh copy, the real factory defaults and a real
 * form. Radix's dialog, scroll area and select are replaced by plain elements (they cost
 * seconds in jsdom or need a pointer the test does not have); the tabs, switches and sliders
 * are the real ones.
 */
jest.mock('electron', () => ({ app: {} }));
jest.mock('next-i18next', () => {
  const i18next = jest.requireActual('i18next');
  const zh = i18next.createInstance();
  zh.init({
    lng: 'zh',
    ns: ['tasks', 'home', 'common'],
    defaultNS: 'tasks',
    resources: {
      zh: {
        tasks: jest.requireActual('../../public/locales/zh/tasks.json'),
        home: jest.requireActual('../../public/locales/zh/home.json'),
        common: jest.requireActual('../../public/locales/zh/common.json'),
      },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  return {
    useTranslation: (ns: string = 'tasks') => ({
      t: zh.getFixedT('zh', ns),
    }),
  };
});
jest.mock('@/components/ui/sheet', () => {
  const passthrough = ({ children }: any) => <div>{children}</div>;
  return {
    Sheet: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    SheetContent: passthrough,
    SheetHeader: passthrough,
    SheetTitle: passthrough,
    SheetDescription: passthrough,
  };
});
jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  const Context = React.createContext({});
  return {
    Select: ({ value, onValueChange, children }: any) => (
      <Context.Provider value={{ value, onValueChange }}>
        {children}
      </Context.Provider>
    ),
    SelectTrigger: React.forwardRef(({ children, ...props }: any, ref: any) => (
      <button type="button" role="combobox" ref={ref} {...props}>
        {children}
      </button>
    )),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => <div role="listbox">{children}</div>,
    SelectItem: ({ value, children }: any) => {
      const { value: current, onValueChange } = React.useContext(Context);
      return (
        <div
          role="option"
          aria-selected={current === value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </div>
      );
    },
  };
});

const GENERATE = getTaskTypeBySlug('generate')!;
const GENERATE_TRANSLATE = getTaskTypeBySlug('generate-translate')!;
const TRANSLATE = getTaskTypeBySlug('translate')!;

/** What `getUserConfig` hands the form of a fresh install. */
const FRESH = { ...defaultUserConfig, subtitleOutcome: 'balanced' };

let form: ReturnType<typeof useForm<any>>;
const onTabChange = jest.fn();

interface HarnessProps {
  typeDef: any;
  defaults?: Record<string, unknown>;
  hasMediaInput?: boolean;
  tab?: 'common' | 'expert';
  open?: boolean;
  controlled?: boolean;
}

function Harness({
  typeDef,
  defaults = FRESH,
  hasMediaInput,
  tab,
  open = true,
  controlled = true,
}: HarnessProps) {
  form = useForm({ defaultValues: defaults });
  return (
    <TaskSettingsSheet
      open={open}
      onOpenChange={() => {}}
      form={form}
      formData={form.watch()}
      typeDef={typeDef}
      hasMediaInput={hasMediaInput}
      tab={tab}
      onTabChange={controlled ? onTabChange : undefined}
    />
  );
}

const mount = async (props: HarnessProps) => {
  const view = render(<Harness {...props} />);
  await act(async () => {});
  return view;
};

/** Radix Tabs selects on pointer down. */
const openTab = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole('tab', { name }), {
      button: 0,
      ctrlKey: false,
    });
  });
};
const change = async (name: string, value: unknown) => {
  await act(async () => {
    form.setValue(name, value, { shouldDirty: true });
  });
};
const groupIds = () =>
  screen
    .queryAllByTestId(/^settings-group-/)
    .map((group) => group.getAttribute('data-testid'));
const optionLabels = (container: HTMLElement) =>
  within(container)
    .getAllByRole('option')
    .map((option) => option.textContent);
const selectedOption = (container: HTMLElement) =>
  within(container).getByRole('option', { selected: true });

let speakerStatus: Record<string, unknown>;

beforeEach(() => {
  onTabChange.mockClear();
  speakerStatus = {};
  // Radix switches, sliders and tabs inside a <form> measure themselves.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  window.ipc = {
    invoke: jest.fn(async (channel: string) => {
      if (channel === 'getSettings') return {};
      if (channel === 'getSpeakerDiarizationModelStatus') return speakerStatus;
      return undefined;
    }),
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  } as any;
});

describe('what the panel is made of', () => {
  test('a media task gets the summary strip and two pages, opening on 常用', async () => {
    await mount({ typeDef: GENERATE });
    expect(screen.getByText('更多设置')).toBeInTheDocument();
    expect(
      screen.getByText('默认值适合大多数视频，按需调整'),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '常用' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: '专家' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByTestId('settings-common')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-expert')).toBeNull();
    // A fresh install is the 通用均衡 scenario, untouched.
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '通用均衡',
    );
    expect(screen.queryByTestId('settings-summary-adjusted')).toBeNull();
    expect(screen.queryByTestId('settings-summary-restore')).toBeNull();
    expect(screen.queryByTestId('settings-expert-dot')).toBeNull();
  });

  test('a task that only translates is one page: no tabs, no scenario, nothing to transcribe', async () => {
    await mount({ typeDef: TRANSLATE });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('settings-summary')).toBeNull();
    expect(groupIds()).toEqual([
      'settings-group-translate',
      'settings-group-output',
      'settings-group-run',
    ]);
    // Nothing that belongs to speech recognition.
    expect(
      screen.queryByRole('switch', { name: '优先使用内封字幕' }),
    ).toBeNull();
    expect(screen.queryByRole('switch', { name: '角色分离' })).toBeNull();
    expect(screen.queryByText('字幕生成提示词')).toBeNull();
    expect(screen.queryByText('保存源字幕文件')).toBeNull();
    expect(screen.queryByText('保存音频')).toBeNull();
    // What it does need.
    expect(screen.getByText('翻译风格')).toBeInTheDocument();
    expect(screen.getByText('字幕文件名设置')).toBeInTheDocument();
    expect(screen.getByText('翻译重试次数')).toBeInTheDocument();
  });

  test('a page the parent asks for still falls back to 常用 when the task has no 专家 page', async () => {
    await mount({ typeDef: TRANSLATE, tab: 'expert' });
    expect(screen.getByTestId('settings-common')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-expert')).toBeNull();
  });

  test('repeats nothing the toolbar owns: no output format, no scenario banner', async () => {
    await mount({ typeDef: GENERATE_TRANSLATE });
    expect(screen.queryByText('字幕输出格式')).toBeNull();
    expect(screen.queryByText(/场景预设/)).toBeNull();
    expect(screen.queryByText(/微调以下参数将自动切换为自定义/)).toBeNull();
    // Nor the segmentation modes and the AI correction switch of 断句与精修.
    expect(screen.queryByText(/AI 断句|智能断句|不限长/)).toBeNull();
  });

  test('the common page is the five groups in the order a task runs, with no expert setting in it', async () => {
    await mount({
      typeDef: GENERATE_TRANSLATE,
      defaults: { ...FRESH, transcriptionEngine: 'fasterWhisper' },
    });
    expect(groupIds()).toEqual([
      'settings-group-source',
      'settings-group-assist',
      'settings-group-translate',
      'settings-group-output',
      'settings-group-run',
    ]);
    const common = screen.getByTestId('settings-common');
    for (const expertText of [
      '识别策略',
      '断句精调',
      '解码参数',
      '高级解码参数',
      '语音活动检测（VAD）',
      '单条字幕最长时长（秒）',
      '停顿断句间隔（秒）',
      '保留原声停顿',
    ]) {
      expect(within(common).queryByText(expertText)).toBeNull();
    }
  });

  test('the reference manuscript is one row: the explanation is a hint, a chosen file gets a card and a way to clear it', async () => {
    await mount({ typeDef: GENERATE });
    const row = screen.getByTestId('setting-manuscript');
    expect(within(row).getByText('全局参考文稿（兜底）')).toBeInTheDocument();
    expect(within(row).getByTestId('setting-hint')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('未在列表单独指定文稿的视频将默认使用此文稿'),
    );
    // The explanation lives in the hint; it is not printed on the page.
    expect(within(row).queryByText(/始终保留 ASR 时间轴/)).toBeNull();
    expect(
      within(row).getByRole('button', { name: '选择 TXT / Markdown' }),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: '清除参考文稿' }),
    ).toBeNull();

    await change('manuscriptPath', '/tmp/notes/talk.md');
    await change('manuscriptName', 'talk.md');
    expect(within(row).getByText('talk.md')).toBeInTheDocument();
    expect(within(row).getByText('/tmp/notes/talk.md')).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: '选择 TXT / Markdown' }),
    ).toBeNull();
    expect(
      within(row).getByRole('button', { name: '更换文稿' }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(row).getByRole('button', { name: '清除参考文稿' }),
      );
    });
    expect(form.getValues('manuscriptPath')).toBe('');
    expect(form.getValues('manuscriptName')).toBe('');
    expect(
      within(row).getByRole('button', { name: '选择 TXT / Markdown' }),
    ).toBeInTheDocument();
  });

  test('a wizard run whose input is only subtitle files has no recognition aids but keeps the rest', async () => {
    await mount({ typeDef: GENERATE_TRANSLATE, hasMediaInput: false });
    expect(screen.queryByTestId('settings-group-source')).toBeNull();
    expect(screen.queryByRole('switch', { name: '角色分离' })).toBeNull();
    expect(screen.getByTestId('settings-group-translate')).toBeInTheDocument();
    expect(screen.getByTestId('settings-group-output')).toBeInTheDocument();
    expect(screen.getByTestId('settings-group-run')).toBeInTheDocument();
  });
});

describe('rows that only matter while another setting is on', () => {
  test('the filler policy follows AI correction, shows what was saved, and hiding it keeps the value', async () => {
    await mount({
      typeDef: GENERATE_TRANSLATE,
      defaults: { ...FRESH, subtitleFillerPolicy: 'preserve' },
    });
    expect(screen.queryByTestId('setting-filler-policy')).toBeNull();

    await change('aiCorrection', true);
    const row = screen.getByTestId('setting-filler-policy');
    expect(selectedOption(row)).toHaveTextContent('保留情绪语气词');

    await change('aiCorrection', false);
    expect(screen.queryByTestId('setting-filler-policy')).toBeNull();
    expect(form.getValues('subtitleFillerPolicy')).toBe('preserve');
  });

  test('a task that does not translate has no translation style, but the filler policy still follows AI correction', async () => {
    await mount({ typeDef: GENERATE });
    expect(screen.queryByTestId('settings-group-translate')).toBeNull();
    expect(screen.queryByText('翻译风格')).toBeNull();
    await change('aiCorrection', true);
    expect(screen.getByTestId('settings-group-translate')).toBeInTheDocument();
    expect(screen.getByTestId('setting-filler-policy')).toBeInTheDocument();
    expect(screen.queryByText('翻译风格')).toBeNull();
  });

  test('speaker count and the write-into-subtitle switch come with the speaker switch', async () => {
    await mount({ typeDef: GENERATE });
    expect(screen.queryByTestId('speaker-diarization-details')).toBeNull();
    expect(screen.queryByText('角色数量')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: '角色分离' }));
    });
    const details = screen.getByTestId('speaker-diarization-details');
    expect(within(details).getByText('角色数量')).toBeInTheDocument();
    expect(
      within(details).getByRole('switch', { name: '将角色标签写入字幕文件' }),
    ).toBeInTheDocument();
    expect(form.getValues('speakerDiarization')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: '角色分离' }));
    });
    expect(screen.queryByTestId('speaker-diarization-details')).toBeNull();
  });

  test('speaker models that are not installed are said next to the switch', async () => {
    speakerStatus = { installed: false, runtimeInstalled: true };
    await mount({
      typeDef: GENERATE,
      defaults: { ...FRESH, speakerDiarization: true },
    });
    expect(screen.getByText('尚未就绪')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('speaker-diarization-details')).getByText(
        /启动前需安装运行库与角色分离模型/,
      ),
    ).toBeInTheDocument();
  });

  test('installed speaker models are a quiet badge and no warning', async () => {
    speakerStatus = { installed: true, runtimeInstalled: true };
    await mount({
      typeDef: GENERATE,
      defaults: { ...FRESH, speakerDiarization: true },
    });
    expect(screen.getByText('运行库与模型已就绪')).toBeInTheDocument();
    expect(screen.queryByText(/启动前需安装运行库与角色分离模型/)).toBeNull();
  });

  test('a file-name template is asked for only when custom naming is chosen', async () => {
    await mount({
      typeDef: GENERATE_TRANSLATE,
      defaults: {
        ...FRESH,
        sourceSrtSaveOption: 'fileName',
        targetSrtSaveOption: 'fileNameWithLang',
      },
    });
    expect(screen.queryByLabelText('请输入自定义原始字幕文件名')).toBeNull();
    expect(screen.queryByLabelText('请输入自定义文件名')).toBeNull();

    await change('sourceSrtSaveOption', 'custom');
    await change('targetSrtSaveOption', 'custom');
    expect(screen.getByLabelText('请输入自定义原始字幕文件名')).toHaveValue(
      '${fileName}.${sourceLanguage}',
    );
    expect(screen.getByLabelText('请输入自定义文件名')).toHaveValue(
      '${fileName}.${targetLanguage}',
    );
  });

  test('a source subtitle that is the deliverable cannot be left unsaved', async () => {
    await mount({
      typeDef: GENERATE,
      defaults: { ...FRESH, sourceSrtSaveOption: 'noSave' },
    });
    const row = screen.getByTestId('setting-source-save');
    expect(optionLabels(row)).not.toContain('不保存');
    expect(selectedOption(row)).toHaveTextContent('文件名');
  });

  test('the line width slider shows only for the two-line layout', async () => {
    await mount({ typeDef: GENERATE });
    expect(screen.queryByText('单行目标宽度（中文计 2）')).toBeNull();
    await change('subtitleLayout', 'two-line');
    expect(screen.getByText('单行目标宽度（中文计 2）')).toBeInTheDocument();
  });

  test('how many tasks run at once explains itself by engine, in a hint rather than on the page', async () => {
    await mount({
      typeDef: GENERATE,
      defaults: { ...FRESH, transcriptionEngine: 'fasterWhisper' },
    });
    const row = screen.getByTestId('setting-max-concurrent');
    expect(within(row).getByTestId('setting-hint')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('该引擎共用单一本地运行时'),
    );
    await change('transcriptionEngine', 'builtin');
    expect(
      within(screen.getByTestId('setting-max-concurrent')).queryByTestId(
        'setting-hint',
      ),
    ).toBeNull();
  });
});

describe('the summary strip', () => {
  test('names the scenario, counts what moved, restores it, and the panel stays open', async () => {
    await mount({
      typeDef: GENERATE,
      defaults: { ...FRESH, scenarioPreset: 'interview' },
    });
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '会议访谈 / 播客',
    );
    const moved = getScenarioState(form.getValues()).groups.length;
    expect(moved).toBeGreaterThan(1);
    expect(screen.getByTestId('settings-summary-adjusted')).toHaveTextContent(
      `已调整 ${moved} 项`,
    );
    expect(screen.getByTestId('settings-expert-dot')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-summary-restore'));
    });
    expect(screen.queryByTestId('settings-summary-adjusted')).toBeNull();
    expect(screen.queryByTestId('settings-summary-restore')).toBeNull();
    expect(screen.queryByTestId('settings-expert-dot')).toBeNull();
    expect(form.getValues('maxSubtitleChars')).toBe(28);
    expect(form.getValues('subtitleOutcome')).toBe('clean');
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '会议访谈 / 播客',
    );
    expect(screen.getByTestId('settings-common')).toBeInTheDocument();
  });

  test('says 自定义 and offers nothing to restore once the strategy was tuned by hand', async () => {
    await mount({
      typeDef: GENERATE,
      defaults: {
        ...FRESH,
        scenarioPreset: 'custom',
        subtitleOutcome: 'custom',
      },
    });
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '自定义',
    );
    expect(screen.queryByTestId('settings-summary-adjusted')).toBeNull();
    expect(screen.queryByTestId('settings-summary-restore')).toBeNull();
  });
});

describe('the 专家 page', () => {
  test('the tab shows a dot when something on that page left the scenario, and 常用 never does', async () => {
    await mount({ typeDef: GENERATE });
    expect(screen.queryByTestId('settings-expert-dot')).toBeNull();

    await change('subtitleMaxDuration', 12);
    expect(
      within(screen.getByRole('tab', { name: /专家/ })).getByTestId(
        'settings-expert-dot',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: '常用' })).queryByTestId(
        'settings-expert-dot',
      ),
    ).toBeNull();
  });

  test('a change on the common page or the toolbar does not mark the 专家 tab', async () => {
    await mount({ typeDef: GENERATE_TRANSLATE });
    await change('subtitleTranslationStyle', 'conversational');
    await change('maxSubtitleChars', 40);
    // The strip counts both, the expert tab none.
    expect(screen.getByTestId('settings-summary-adjusted')).toHaveTextContent(
      '已调整 2 项',
    );
    expect(screen.queryByTestId('settings-expert-dot')).toBeNull();
  });

  test('switching pages keeps what was entered, dirty flag included', async () => {
    await mount({ typeDef: GENERATE, controlled: false });
    await openTab('专家');
    const slider = () =>
      within(screen.getByTestId('setting-subtitleMaxDuration')).getByRole(
        'slider',
      );
    expect(slider()).toHaveAttribute('aria-valuenow', '8');

    await act(async () => {
      fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    });
    expect(form.getValues('subtitleMaxDuration')).toBe(8.5);
    expect(form.formState.dirtyFields.subtitleMaxDuration).toBe(true);

    await openTab('常用');
    expect(screen.queryByTestId('settings-expert')).toBeNull();
    expect(form.getValues('subtitleMaxDuration')).toBe(8.5);
    expect(form.formState.dirtyFields.subtitleMaxDuration).toBe(true);

    await openTab(/专家/);
    expect(slider()).toHaveAttribute('aria-valuenow', '8.5');
  });

  test('opens on the page it is told to and reports the page the user picks', async () => {
    await mount({ typeDef: GENERATE, tab: 'expert' });
    expect(screen.getByTestId('settings-expert')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-common')).toBeNull();
    expect(screen.getByRole('tab', { name: '专家' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await openTab('常用');
    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith('common');
  });

  test('on its own, comes back to the page it was closed on', async () => {
    const view = await mount({ typeDef: GENERATE, controlled: false });
    await openTab(/专家/);
    expect(screen.getByTestId('settings-expert')).toBeInTheDocument();

    view.rerender(
      <Harness typeDef={GENERATE} open={false} controlled={false} />,
    );
    expect(screen.queryByTestId('settings-expert')).toBeNull();
    view.rerender(<Harness typeDef={GENERATE} open controlled={false} />);
    await act(async () => {});
    expect(screen.getByTestId('settings-expert')).toBeInTheDocument();
  });

  test('groups the recognition strategy, the segmentation tuning and, for faster-whisper only, the decoding', async () => {
    await mount({ typeDef: GENERATE, tab: 'expert' });
    expect(groupIds()).toEqual([
      'settings-group-strategy',
      'settings-group-segment-tuning',
    ]);
    expect(screen.queryByText('高级解码参数')).toBeNull();

    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'fasterWhisper' },
    });
    expect(groupIds()).toContain('settings-group-decoding');
  });
});

describe('识别策略 follows the engine', () => {
  test.each(['cloud', 'localCli'])(
    '%s is not asked to choose, only told why',
    async (engine) => {
      await mount({
        typeDef: GENERATE,
        tab: 'expert',
        defaults: { ...FRESH, transcriptionEngine: engine },
      });
      expect(screen.getByTestId('outcome-unsupported')).toHaveTextContent(
        '不使用识别策略',
      );
      expect(screen.queryByTestId('setting-outcome')).toBeNull();
      expect(screen.queryByTestId('outcome-manual')).toBeNull();
      // The rest of the page is unaffected.
      expect(
        screen.getByTestId('setting-subtitleMaxDuration'),
      ).toBeInTheDocument();
    },
  );

  test('a local engine offers the three tiers and 手动调节, and says what the current one does', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'builtin' },
    });
    const row = screen.getByTestId('setting-outcome');
    expect(optionLabels(row)).toEqual([
      '文字最准',
      '均衡推荐',
      '最干净最稳',
      '手动调节',
    ]);
    expect(selectedOption(row)).toHaveTextContent('均衡');
    expect(screen.getByTestId('outcome-description')).toHaveTextContent(
      '文字完整又干净、时间轴稳',
    );
    expect(screen.getByTestId('outcome-description')).toHaveTextContent(
      '适合大多数视频，拿不准就选它',
    );
    expect(screen.queryByTestId('outcome-manual')).toBeNull();
  });

  test('picking another tier moves the task off its scenario, and the strip and tab say so', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'builtin' },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('setting-outcome')).getByRole('option', {
          name: '最干净最稳',
        }),
      );
    });
    expect(form.getValues('subtitleOutcome')).toBe('clean');
    expect(screen.getByTestId('outcome-description')).toHaveTextContent(
      '最大力度抑制重复与幻觉字幕',
    );
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '通用均衡',
    );
    expect(screen.getByTestId('settings-summary-adjusted')).toHaveTextContent(
      '已调整 1 项',
    );
    expect(screen.getByTestId('settings-expert-dot')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-summary-restore'));
    });
    expect(form.getValues('subtitleOutcome')).toBe('balanced');
    expect(screen.queryByTestId('settings-expert-dot')).toBeNull();
  });

  test('手动调节 turns the scenario into 自定义 and opens the low-level parameters', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'builtin' },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('setting-outcome')).getByRole('option', {
          name: '手动调节',
        }),
      );
    });
    expect(form.getValues('subtitleOutcome')).toBe('custom');
    expect(form.getValues('scenarioPreset')).toBe('custom');
    const manual = screen.getByTestId('outcome-manual');
    expect(within(manual).getByText('手动调节参数')).toBeInTheDocument();
    expect(within(manual).getByText('语音活动检测（VAD）')).toBeInTheDocument();
    expect(screen.getByTestId('settings-summary-scenario')).toHaveTextContent(
      '自定义',
    );
    expect(screen.queryByTestId('settings-summary-restore')).toBeNull();
  });
});

describe('leaving 手动调节 for a tier', () => {
  const pick = async (name: string) => {
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('setting-outcome')).getByRole('option', {
          name,
        }),
      );
    });
  };
  /** The values 手动调节 writes into the task. */
  const manualKnobs = [
    'maxContext',
    'useVAD',
    'reduceRepetition',
    ...TASK_VAD_FIELDS,
  ];
  /** What the recognizer is handed for the task in the form (no global overrides). */
  const effective = () => resolveEffectiveSettings(form.getValues(), {});

  test('opening 手动调节 and changing nothing does not freeze the VAD of the tier it replaced', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'funasr' },
    });
    await pick('手动调节');
    await pick('最干净最稳');
    expect(form.getValues('subtitleOutcome')).toBe('clean');
    // 最干净最稳 on a sherpa engine is the noisy-room VAD, not the 均衡 one the task came from.
    expect(effective()).toMatchObject({
      vadThreshold: 0.65,
      vadMinSpeechDuration: 400,
      vadMinSilenceDuration: 150,
    });
    for (const key of manualKnobs) expect(form.getValues(key)).toBeUndefined();
    // The scenario label stays 自定义 on purpose: it only goes one way.
    expect(form.getValues('scenarioPreset')).toBe('custom');
  });

  test('a slider moved on 手动调节 does not outlive it', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'fasterWhisper' },
    });
    await pick('手动调节');
    await change('vadThreshold', 0.2);
    await change('vadMinSpeechDuration', 600);
    await pick('文字最准');
    expect(form.getValues('subtitleOutcome')).toBe('accurate');
    // 文字最准 on faster-whisper keeps brief and quiet speech.
    expect(effective()).toMatchObject({
      vadThreshold: 0.35,
      vadMinSpeechDuration: 100,
    });
    for (const key of manualKnobs) expect(form.getValues(key)).toBeUndefined();
  });

  test('an old task that only reads as 手动调节 from its knobs goes back to the tier too', async () => {
    // Saved before the tiers existed: no `subtitleOutcome`, a tuned context and VAD.
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: {
        ...FRESH,
        subtitleOutcome: undefined,
        transcriptionEngine: 'fasterWhisper',
        maxContext: 0,
        vadThreshold: 0.2,
      },
    });
    expect(
      selectedOption(screen.getByTestId('setting-outcome')),
    ).toHaveTextContent('手动调节');
    await pick('最干净最稳');
    expect(form.getValues('subtitleOutcome')).toBe('clean');
    for (const key of manualKnobs) expect(form.getValues(key)).toBeUndefined();
  });

  test('picking between the tiers leaves what the scenario set alone', async () => {
    await mount({
      typeDef: GENERATE,
      tab: 'expert',
      defaults: { ...FRESH, transcriptionEngine: 'funasr' },
    });
    await act(async () => {
      applyScenarioPreset(form, 'interview');
    });
    await pick('文字最准');
    expect(form.getValues('subtitleOutcome')).toBe('accurate');
    expect(form.getValues('vadThreshold')).toBe(0.35);
    expect(form.getValues('useVAD')).toBe(true);
    expect(form.getValues('scenarioPreset')).toBe('interview');
  });
});
