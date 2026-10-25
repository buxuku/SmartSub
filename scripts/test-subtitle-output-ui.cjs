const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const originalLoad = Module._load;
const extensions = {
  '.ts': require.extensions['.ts'],
  '.tsx': require.extensions['.tsx'],
};
for (const ext of Object.keys(extensions))
  require.extensions[ext] = (module, filename) => {
    module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
  };
Module._load = function (request, parent, isMain) {
  if (request === 'next/router')
    return {
      useRouter: () => ({
        query: { locale: 'en' },
        asPath: '/en/tasks/new',
        push() {},
      }),
    };
  if (request === 'next-i18next')
    return { useTranslation: () => ({ t: (key) => key }) };
  let resolved = request;
  if (request.startsWith('@/'))
    resolved = path.resolve(__dirname, '../renderer', request.slice(2));
  else if (/^(lib|hooks|components)\//.test(request))
    resolved = path.resolve(__dirname, '../renderer', request);
  return originalLoad.call(this, resolved, parent, isMain);
};
try {
  const {
    default: InlineConfigBar,
  } = require('../renderer/components/tasks/InlineConfigBar.tsx');
  const { TASK_TYPES } = require('../renderer/lib/taskTypes.ts');
  for (const typeDef of TASK_TYPES) {
    const html = renderToStaticMarkup(
      React.createElement(InlineConfigBar, {
        form: { setValue() {} },
        formData: {
          taskType: typeDef.taskType,
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          translateProvider: '-1',
          subtitleOutputFormats: ['srt', 'txt'],
        },
        typeDef,
        systemInfo: { modelsInstalled: [], downloadingModels: [] },
        providers: [],
        asrProviders: [],
        useLocalWhisper: false,
      }),
    );
    assert.ok(
      html.includes('aria-label="subtitleOutputFormat"'),
      `${typeDef.taskType}: the shared wizard configuration exposes output formats`,
    );
    assert.ok(
      html.includes('SRT, TXT'),
      `${typeDef.taskType}: the selected formats are visible`,
    );
    // 配置行只放定高控件：开关、摘要服务等可变宽内容必须收进弹层，
    // 否则开启后会把同一 nowrap 行里的其余控件挤成几十像素。
    assert.ok(
      !html.includes('role="switch"'),
      `${typeDef.taskType}: the inline config row holds no inline switches`,
    );
    assert.equal(
      html.includes('data-testid="summary-control-trigger"'),
      Boolean(typeDef.hasTranslate),
      `${typeDef.taskType}: only translating task types expose the summary trigger`,
    );
  }
  console.log(
    'Subtitle format UI: all 3 wizard/task types expose the multi-format selector',
  );

  // 「生成摘要」在配置行里始终是同一个定高状态按钮：
  // 关闭 / 待配置 / 服务名三种状态只换按钮上的文字，不展开任何行内内容。
  const translateDef = TASK_TYPES.find((def) => def.hasTranslate);
  assert.ok(translateDef, 'at least one task type translates');
  const aiProvider = {
    id: 'ai-1',
    name: 'Test AI',
    type: 'unknown-ai-type',
    isAi: true,
  };
  const renderTranslate = (formData, providers = []) =>
    renderToStaticMarkup(
      React.createElement(InlineConfigBar, {
        form: { setValue() {} },
        formData: {
          taskType: translateDef.taskType,
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          translateProvider: '-1',
          subtitleOutputFormats: ['srt'],
          ...formData,
        },
        typeDef: translateDef,
        systemInfo: { modelsInstalled: [], downloadingModels: [] },
        providers,
        asrProviders: [],
        useLocalWhisper: false,
      }),
    );
  const summaryTrigger = (html) =>
    html.match(
      /<button[^>]*data-testid="summary-control-trigger"[^>]*>.*?<\/button>/,
    )?.[0] ?? '';
  const summaryStates = {
    off: renderTranslate({}),
    warning: renderTranslate({ generateSummary: true }),
    ready: renderTranslate(
      { generateSummary: true, translateProvider: 'ai-1' },
      [aiProvider],
    ),
    explicit: renderTranslate(
      { generateSummary: true, summaryProvider: 'ai-1' },
      [aiProvider],
    ),
  };
  assert.ok(
    summaryTrigger(summaryStates.off).includes('configBar.summaryStateOff'),
    'summary trigger reads "off" when the summary is disabled',
  );
  assert.ok(
    summaryTrigger(summaryStates.warning).includes(
      'configBar.summaryStateWarning',
    ),
    'summary trigger warns when enabled without a usable AI service',
  );
  assert.ok(
    summaryTrigger(summaryStates.ready).includes('provider.Test AI'),
    'summary trigger shows the followed translation service',
  );
  assert.ok(
    summaryTrigger(summaryStates.explicit).includes('provider.Test AI'),
    'summary trigger shows the explicitly chosen summary service',
  );
  for (const [state, html] of Object.entries(summaryStates)) {
    assert.ok(
      !html.includes('role="switch"'),
      `summary ${state}: no inline switch`,
    );
    assert.ok(
      !html.includes('configBar.summaryProvider') &&
        !html.includes('configBar.summarySkipHint'),
      `summary ${state}: service picker and hints stay inside the popover`,
    );
  }
  console.log(
    'Summary toolbar UI: one fixed-height trigger across off / warning / on states',
  );

  // 配置行的标签与提示都不能撑宽、撑高：
  // - 标签单行截断（窄窗口下以省略号收尾，不再溢出盖住相邻控件）；
  // - autoFree 的网络提示是标签旁的 ⓘ，而不是控件上方的整段文字
  //   （后者在窄窗口里会折成很多行，把整条配置条撑高）；
  // - 「去下载模型」「去配置翻译服务」入口的文字在按钮内截断。
  const autoFreeProvider = {
    id: 'autoFree',
    type: 'autoFree',
    name: 'autoFree',
    isAi: false,
  };
  const toolbarHtml = {
    autoFree: renderTranslate({ translateProvider: 'autoFree' }, [
      autoFreeProvider,
    ]),
    other: renderTranslate({ translateProvider: 'ai-1' }, [aiProvider]),
    empty: renderTranslate({}),
  };
  for (const [state, html] of Object.entries(toolbarHtml)) {
    assert.ok(
      html.includes('class="truncate text-xs text-muted-foreground"'),
      `${state}: config labels truncate instead of overflowing`,
    );
    assert.ok(
      !html.includes('class="text-xs text-muted-foreground whitespace-nowrap"'),
      `${state}: no label keeps the old non-truncating nowrap style`,
    );
    assert.ok(
      !html.includes('<p class="text-[11px] text-muted-foreground">'),
      `${state}: no standalone hint paragraph above a control`,
    );
  }
  assert.ok(
    toolbarHtml.autoFree.includes('data-testid="config-item-hint"') &&
      toolbarHtml.autoFree.includes('aria-label="freeTranslationNetworkHint"'),
    'autoFree: the network hint is an info icon next to the label',
  );
  assert.ok(
    !toolbarHtml.other.includes('config-item-hint') &&
      !toolbarHtml.empty.includes('config-item-hint'),
    'other providers: no hint icon',
  );
  assert.ok(
    toolbarHtml.empty.includes(
      '<span class="truncate">goDownloadModel</span>',
    ) &&
      toolbarHtml.empty.includes(
        '<span class="truncate">goConfigureProvider</span>',
      ),
    'empty states: call-to-action text truncates inside its button',
  );
  console.log(
    'Toolbar labels: truncating labels, hint as an info icon, truncating call-to-action buttons',
  );

  // 工具栏按流水线阶段排列：听（语音模型、视频语言、场景、断句与精修）｜
  // 译（翻译成、翻译服务、词库、生成摘要）｜ 出（输出）。各任务类型只显示与自己
  // 相关的控件，相对顺序不变。紧凑工具栏共用可换行的 fieldset，宽度不足时
  // 自然换行，不再依赖阶段首项的左边框来分隔（换行后会落在错误位置）。
  const toolbarOrder = {
    generateAndTranslate: [
      'configBar.model',
      'configBar.sourceLanguage',
      'configBar.scenario',
      'refine.control.label',
      'configBar.targetLanguage',
      'configBar.provider',
      'configBar.glossary',
      'configBar.generateSummary',
      'configBar.output',
    ],
    generateOnly: [
      'configBar.model',
      'configBar.sourceLanguage',
      'configBar.scenario',
      'refine.control.label',
      'configBar.output',
    ],
    translateOnly: [
      'configBar.subtitleSourceLanguage',
      'configBar.targetLanguage',
      'configBar.provider',
      'configBar.glossary',
      'configBar.generateSummary',
      'configBar.output',
    ],
  };
  for (const typeDef of TASK_TYPES) {
    const html = renderToStaticMarkup(
      React.createElement(InlineConfigBar, {
        form: { setValue() {} },
        formData: {
          taskType: typeDef.taskType,
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          translateProvider: '-1',
          subtitleOutputFormats: ['srt'],
        },
        typeDef,
        systemInfo: { modelsInstalled: [], downloadingModels: [] },
        providers: [],
        asrProviders: [],
        useLocalWhisper: false,
      }),
    );
    const labels = [
      ...html.matchAll(
        /<span title="([^"]+)" class="truncate text-xs text-muted-foreground">/g,
      ),
    ].map((match) => match[1]);
    assert.deepEqual(
      labels,
      toolbarOrder[typeDef.taskType],
      `${typeDef.taskType}: the toolbar runs 听 → 译 → 出`,
    );
    assert.match(
      html,
      /<fieldset[^>]*class="[^"]*\bflex-wrap\b/,
      `${typeDef.taskType}: compact controls can wrap without clipping`,
    );
    assert.ok(
      !html.includes('title="configBar.format"') &&
        !html.includes('>configBar.format<'),
      `${typeDef.taskType}: the output control is labelled 输出; 字幕格式 is a title inside its popover`,
    );
  }
  console.log(
    'Toolbar order: 听 → 译 → 出 for all 3 task types in a wrapping compact toolbar',
  );
} finally {
  Module._load = originalLoad;
  for (const [ext, original] of Object.entries(extensions)) {
    if (original) require.extensions[ext] = original;
    else delete require.extensions[ext];
  }
}
