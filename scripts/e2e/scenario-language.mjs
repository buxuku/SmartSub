import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-language-e2e-'),
);
const media = path.join(output, 'dialogue.wav');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  '/Volumes/Macintosh HD - Data/Storage/xiaodong/smartsub/asr-zh-60s.wav',
  '-t',
  '3',
  '-ac',
  '1',
  '-ar',
  '16000',
  media,
]);
const raw = 'Um, Kubernets is ready. Ah!';
const corrected = 'Kubernetes is ready. Ah!';
const translated =
  '啊，容器编排已经就绪，现在我们终于可以开始下一段精彩的故事了！';
let malformed = false;
const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      if (request.url === '/v1/audio/transcriptions') {
        requests.push({ kind: 'asr' });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            text: raw,
            language: 'en',
            duration: 3,
            segments: [{ start: 0, end: 2, text: raw }],
          }),
        );
        return;
      }
      if (request.url !== '/v1/chat/completions')
        return response.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const system = body.messages.find(
        (message) => message.role === 'system',
      ).content;
      const content = body.messages.find(
        (message) => message.role === 'user',
      ).content;
      const correction = system.includes('proofreader for speech-recognition');
      requests.push({
        kind: correction ? 'correction' : 'translation',
        system,
      });
      const input = JSON.parse(
        correction ? content.slice(content.indexOf('\n') + 1) : content,
      );
      const result = Object.fromEntries(
        Object.entries(input).map(([id, src]) => [
          id,
          {
            src: malformed ? 'unrelated echoed text' : src,
            tr: correction ? corrected : translated,
          },
        ]),
      );
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(result) },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    } catch (error) {
      console.error('Local language fixture failed:', error.message);
      response.writeHead(500).end(error.message);
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(output, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
  });
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const ai = {
    id: 'language-ai',
    name: 'Local language AI',
    type: 'openai',
    isAi: true,
    apiUrl,
    apiKey: 'test-only',
    modelName: 'fixture',
    prompt: '${content}',
    echoAnchoring: true,
    useJsonMode: true,
    requestInterval: 0,
  };
  const mt = {
    id: 'language-mt',
    name: 'Standard MT',
    type: 'deeplx',
    isAi: false,
    apiUrl: `${apiUrl}/unused`,
    requestInterval: 0,
  };
  await page.evaluate(
    async ({ apiUrl, ai, mt }) => {
      window.ipc.send('setAsrProviders', [
        {
          id: 'language-asr',
          name: 'Local ASR',
          type: 'openaiCompatible',
          apiUrl,
          apiKey: 'test-only',
          models: ['whisper-1'],
        },
      ]);
      window.ipc.send('setTranslationProviders', [ai, mt]);
      const glossary = await window.ipc.invoke('glossaries:create', {
        name: 'Scenario terms',
      });
      if (!glossary.success) throw Error(JSON.stringify(glossary));
      const entry = await window.ipc.invoke('glossaries:save-entry', {
        glossaryId: glossary.data.id,
        entry: { source: 'Kubernetes', target: '容器编排' },
      });
      if (!entry.success) throw Error(JSON.stringify(entry));
    },
    { apiUrl, ai, mt },
  );
  const settings = await page.evaluate(() => window.ipc.invoke('getSettings'));
  const key = 'smartsub_task_wizard_draft_v1';
  const prepare = async (name, translate) => {
    const source = path.join(output, `${name}.wav`);
    await fs.copyFile(media, source);
    await page.evaluate(
      async ({ key, source, translate }) => {
        const files = await window.ipc.invoke('getDroppedFiles', {
          files: [source],
          taskType: 'media',
        });
        const defaults = await window.ipc.invoke('getUserConfig');
        localStorage.setItem(
          key,
          JSON.stringify({
            files,
            goals: { translate, dub: false, video: false },
            config: {
              ...defaults,
              transcriptionEngine: 'cloud',
              asrProviderId: 'language-asr',
              model: 'whisper-1',
              sourceLanguage: 'en',
              targetLanguage: 'zh',
              translateProvider: translate ? 'language-mt' : '-1',
              refineProvider: 'language-ai',
              sourceSrtSaveOption: 'fileName',
              targetSrtSaveOption: 'fileNameWithLang',
              translateContent: 'onlyTranslate',
              useEmbeddedSubtitles: false,
            },
            savedAt: Date.now(),
          }),
        );
      },
      { key, source, translate },
    );
    await page.goto(`${origin}/zh/tasks/new/`);
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await page.getByRole('button', { name: /^(通用均衡|专家自定义)$/ }).click();
  };
  const start = async () => {
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await page.getByRole('button', { name: '本次上传', exact: true }).click();
    await expect(page).toHaveURL(/project=/);
    const id = new URL(page.url()).searchParams.get('project');
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.ipc.invoke('getWorkItem', id),
              id,
            )
          )?.pipelineFiles?.[0]?.exportSubtitle,
        { timeout: 60000 },
      )
      .toBe('done');
    return page.evaluate((id) => window.ipc.invoke('getWorkItem', id), id);
  };
  await prepare('lecture', false);
  await page.getByRole('button', { name: /^网课演讲 \/ 教程/ }).click();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  const lecture = await start();
  assert.equal(lecture.configSnapshot.aiCorrection, true);
  assert.equal(lecture.configSnapshot.subtitleOutcome, 'clean');
  const lectureText = await fs.readFile(
    lecture.pipelineFiles[0].srtFile,
    'utf8',
  );
  assert.ok(lectureText.includes(corrected) && !lectureText.includes('Um,'));
  const correctionRequest = requests.find(
    (request) => request.kind === 'correction',
  );
  assert.ok(
    correctionRequest.system.includes('Remove only semantically empty'),
  );
  assert.ok(
    correctionRequest.system.includes('Kubernetes') &&
      !correctionRequest.system.includes('容器编排'),
  );
  await page.screenshot({ path: path.join(output, 'lecture-completed.png') });

  await prepare('short-drama', true);
  await page.getByRole('button', { name: /^影视 \/ Vlog/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key)).config.subtitleTranslationStyle,
        key,
      ),
    )
    .toBe('conversational');
  await page.getByRole('button', { name: '影视 / Vlog', exact: true }).click();
  await page.getByRole('button', { name: /^短剧 \/ 短视频/ }).click();
  await expect(
    page.getByText(
      '情感口语化翻译需要 AI 翻译服务。请选择 AI 服务，或在专家参数中切换为常规翻译。',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '常规翻译', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '专家自定义', exact: true }).click();
  await page.getByRole('button', { name: /^短剧 \/ 短视频/ }).click();
  await page.getByRole('combobox', { name: '翻译服务', exact: true }).click();
  await page.getByRole('option', { name: /Local language AI/ }).click();
  await expect(
    page.getByRole('button', { name: '开始', exact: true }),
  ).toBeEnabled();
  const drama = await start();
  assert.equal(drama.configSnapshot.scenarioPreset, 'shortDrama');
  assert.equal(drama.configSnapshot.subtitleTranslationStyle, 'conversational');
  assert.equal(drama.configSnapshot.subtitleLayout, 'two-line');
  const delivery = await fs.readFile(
    drama.pipelineFiles[0].translatedSrtFile,
    'utf8',
  );
  const lines = delivery.trim().split('\n');
  assert.equal(lines.length, 4, 'one cue with exactly two display lines');
  assert.equal(lines.slice(2).join(''), translated);
  const metadata = JSON.parse(
    await fs.readFile(drama.pipelineFiles[0].proofreadDataFile, 'utf8'),
  );
  assert.equal(
    metadata.cues[0].target,
    translated,
    'sidecar retains unwrapped target',
  );
  assert.ok(
    (
      await fs.readFile(drama.pipelineFiles[0].tempTranslatedSrtFile, 'utf8')
    ).includes(translated),
    'TTS cache retains unwrapped target',
  );
  assert.equal(metadata.cues[0].startMs, 0);
  assert.equal(metadata.cues[0].endMs, 2000);
  assert.ok(
    requests
      .find((request) => request.kind === 'translation')
      .system.includes('<subtitle-style>'),
  );
  await page.screenshot({ path: path.join(output, 'drama-completed.png') });

  malformed = true;
  await prepare('rejected-correction', false);
  await page.getByRole('button', { name: /^网课演讲 \/ 教程/ }).click();
  const rejected = await start();
  assert.match(
    rejected.pipelineFiles[0].refineSubtitleError,
    /AI_CORRECTION_VALIDATION_FAILED/,
  );
  assert.ok(
    (await fs.readFile(rejected.pipelineFiles[0].srtFile, 'utf8')).includes(
      raw,
    ),
  );
  await expect(page.getByText(/1 条 AI 校正未通过校验/)).toBeVisible();
  await page.screenshot({ path: path.join(output, 'correction-warning.png') });
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getSettings')),
    settings,
  );
  assert.deepEqual(
    await page.evaluate(() => window.ipc.invoke('getTranslationProviders')),
    [ai, mt],
  );
  console.log(
    JSON.stringify({
      output,
      requests: requests.map((request) => request.kind),
      checks: [
        'four scenario UI',
        'lecture ASR and correction pipeline',
        'source-only glossary',
        'AI style readiness and correction action',
        'short-drama translation prompt and output',
        'two-line delivery with original timing and unwrapped TTS/sidecar',
        'invalid echo warning retains input',
        'global settings and provider isolation',
      ],
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  console.error(`Scenario language evidence: ${output}`);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
