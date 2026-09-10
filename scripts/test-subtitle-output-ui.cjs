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
  }
  console.log(
    'Subtitle format UI: all 3 wizard/task types expose the multi-format selector',
  );
} finally {
  Module._load = originalLoad;
  for (const [ext, original] of Object.entries(extensions)) {
    if (original) require.extensions[ext] = original;
    else delete require.extensions[ext];
  }
}
