import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const constantsPath = path.resolve('renderer/components/subtitleMerge/constants.ts');
const constantsCode = ts.transpileModule(await fs.readFile(constantsPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const constants = { exports: {} };
new Function('module', 'exports', constantsCode)(constants, constants.exports);
const { DEFAULT_STYLE } = constants.exports;

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-compose-output-e2e-'));
const video = path.join(output, 'video.mp4');
const original = path.join(output, 'original.srt');
const injected = path.join(output, 'new.srt');
const attachment = path.join(output, 'notes.txt');
const source = path.join(output, 'with-subtitles.mkv');
const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
run(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
await fs.writeFile(original, '1\n00:00:00,125 --> 00:00:02,875\nOriginal embedded track\n');
await fs.writeFile(injected, '1\n00:00:00,250 --> 00:00:02,750\nNew selected track\n');
await fs.writeFile(attachment, 'Keep this MKV attachment');
run(['-i', video, '-i', original, '-map', '0', '-map', '0:a:0', '-map', '1:s:0', '-c', 'copy', '-c:s', 'ass', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default+forced', '-attach', attachment, '-metadata:s:t:0', 'mimetype=text/plain', source]);
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sourceHash = await hash(source);
const videoHash = file => run(['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1']).toString().trim();
const probe = file => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (error) { return error.stderr.toString(); } return ''; };
const checks = [];
let app, page;
try {
  app = await _electron.launch({ args: ['.', process.env.SMARTSUB_RENDERER_PORT || '8888', `--user-data-dir=${path.join(output, 'profile')}`], env: { ...process.env, NODE_ENV: 'development' } });
  page = await app.firstWindow();
  page.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => {}); });
  page.setDefaultTimeout(20000);
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => { BrowserWindow.getAllWindows().forEach(window => window.webContents.closeDevTools()); dialog.showMessageBoxSync = () => 0; });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.evaluate(({ source, injected }) => window.next.router.push(`/zh/subtitleMerge/?video=${encodeURIComponent(source)}&subtitle=${encodeURIComponent(injected)}`), { source, injected });
  const color = page.locator('input[type="text"][aria-label="字体颜色"]');
  await color.fill('#F');
  await expect(page.getByRole('alert').filter({ hasText: '请修正后再导出：字体颜色' })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成视频', exact: true })).toBeDisabled();
  await expect(page.locator('[data-preview-error]')).toBeVisible();
  const invalidStyle = await page.evaluate(config => window.ipc.invoke('subtitleMerge:startMerge', config), { videoPath: source, subtitlePath: injected, outputPath: path.join(output, 'invalid-style.mp4'), style: { ...DEFAULT_STYLE, primaryColor: '#F' } });
  assert.equal(invalidStyle.success, false);
  assert.match(invalidStyle.error, /Invalid subtitle style/);
  await color.fill('#FFFFFF');
  await expect(page.getByRole('alert').filter({ hasText: '请修正后再导出' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成视频', exact: true })).toBeEnabled();
  await expect(page.locator('[data-preview-error]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Boolean(window.__jassubPreview))).toBe(true);
  checks.push('partial color stays editable; persistent field error and disabled hard export; IPC rejects invalid style; correction recovers');
  await page.getByRole('button', { name: '封装软字幕', exact: true }).click();
  await expect(page.getByText('MKV 保留原字幕和附件，新字幕为默认轨；数据流不写入。', { exact: true })).toBeVisible();
  const oldOutput = path.join(output, 'existing.mkv');
  await fs.writeFile(oldOutput, 'PREVIOUS EXPORT MUST SURVIVE');
  const selectOutput = async file => {
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
    await page.getByRole('button', { name: '选择输出路径', exact: true }).click();
  };
  await selectOutput(oldOutput);
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({ timeout: 60000 });
  const newOutput = path.join(output, 'existing_2.mkv');
  await expect(page.getByRole('textbox', { name: '选择输出路径', exact: true })).toHaveValue(newOutput);
  assert.equal(await fs.readFile(oldOutput, 'utf8'), 'PREVIOUS EXPORT MUST SURVIVE');
  assert.equal(await hash(source), sourceHash);
  const mkvStreams = probe(newOutput);
  assert.match(mkvStreams, /Subtitle: subrip.*\(default\)/);
  assert.match(mkvStreams, /Subtitle: ass.*\(forced\)/);
  assert.doesNotMatch(mkvStreams, /Subtitle: ass.*\(default\)/);
  assert.match(mkvStreams, /Attachment: /);
  assert.equal((mkvStreams.match(/Audio:/g) || []).length, 2);
  const first = run(['-i', newOutput, '-map', '0:s:0', '-f', 'srt', 'pipe:1']).toString();
  const second = run(['-i', newOutput, '-map', '0:s:1', '-f', 'srt', 'pipe:1']).toString();
  assert.match(first, /New selected track/);
  assert.match(first, /00:00:00,250 --> 00:00:02,750/);
  assert.match(second, /Original embedded track/);
  assert.equal(videoHash(newOutput), videoHash(source));
  checks.push('existing output byte-preserved, actual collision path shown, new default SRT plus original ASS/forced flag/attachment, video packet hash unchanged');

  await selectOutput(source);
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  const failure = page.getByRole('alert').filter({ hasText: '视频生成失败' });
  await expect(failure).toBeVisible();
  await failure.getByText('错误详情', { exact: true }).click();
  await expect(failure.getByText(/Output cannot replace an input file/)).toBeVisible();
  assert.equal(await hash(source), sourceHash);
  checks.push('source-as-output rejected through UI; source hash unchanged');
  await page.getByRole('combobox', { name: '软字幕容器', exact: true }).click();
  await page.getByRole('option', { name: 'MP4', exact: true }).click();
  await expect(page.getByText(/MP4 保留音视频和文本字幕/)).toBeVisible();
  const mp4 = path.join(output, 'text-tracks.mp4');
  await selectOutput(mp4);
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByText('视频生成成功', { exact: true })).toBeVisible({ timeout: 60000 });
  const mp4Streams = probe(mp4);
  assert.equal((mp4Streams.match(/Subtitle: mov_text/g) || []).length, 2);
  assert.doesNotMatch(mp4Streams, /Attachment: /);
  assert.match(run(['-i', mp4, '-map', '0:s:1', '-f', 'srt', 'pipe:1']).toString(), /Original embedded track/);
  assert.equal(videoHash(mp4), videoHash(source));
  checks.push('MP4 retains both text tracks as mov_text, excludes unsupported attachment, copies video packets');

  const hard = path.join(output, 'burned.mkv');
  const hardResult = await page.evaluate(config => window.ipc.invoke('subtitleMerge:startMerge', config), { videoPath: source, subtitlePath: injected, outputPath: hard, style: DEFAULT_STYLE, outputMode: 'hardcode', encoderMode: 'cpu' });
  assert.equal(hardResult.success, true, JSON.stringify(hardResult));
  const hardStreams = probe(hard);
  assert.equal((hardStreams.match(/Audio:/g) || []).length, 2);
  assert.doesNotMatch(hardStreams, /Subtitle: /);
  assert.doesNotMatch(hardStreams, /Attachment: /);
  checks.push('hard burn retains both original audio tracks, no automatic embedded subtitle causing duplicate captions');

  const silent = path.join(output, 'silent.mp4');
  const voice = path.join(output, 'voice.wav');
  run(['-i', video, '-an', '-c:v', 'copy', silent]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', voice]);
  const silentInfo = await page.evaluate(videoPath => window.ipc.invoke('subtitleMerge:getVideoInfo', { videoPath }), silent);
  assert.equal(silentInfo.success, true);
  assert.equal(silentInfo.data.hasAudio, false);
  for (const outputMode of ['hardcode', 'softmux']) {
    const mixed = path.join(output, `silent-mix-${outputMode}.mp4`);
    const mixedResult = await page.evaluate(config => window.ipc.invoke('subtitleMerge:startMerge', config), { videoPath: silent, subtitlePath: injected, outputPath: mixed, style: DEFAULT_STYLE, outputMode, audioTrack: { mode: 'mix', trackPath: voice } });
    assert.equal(mixedResult.success, true, JSON.stringify(mixedResult));
    assert.equal((probe(mixed).match(/Audio:/g) || []).length, 1);
  }
  checks.push('real IPC metadata detects no source audio; hard/soft mix both produce a playable selected voice track');

  const invalid = path.join(output, 'broken.srt');
  await fs.writeFile(invalid, 'Not a subtitle');
  const response = await page.evaluate(config => window.ipc.invoke('subtitleMerge:startMerge', config), { videoPath: source, subtitlePath: invalid, outputPath: oldOutput, outputMode: 'softmux' });
  assert.equal(response.success, false);
  assert.equal(await fs.readFile(oldOutput, 'utf8'), 'PREVIOUS EXPORT MUST SURVIVE');
  assert.equal(await hash(source), sourceHash);
  assert.equal((await fs.readdir(output)).some(name => name.startsWith('.smartsub-compose-')), false);
  checks.push('real FFmpeg failure preserves existing result and source, private temporary directory removed');
  await page.screenshot({ path: path.join(output, 'success.png') });
  for (const [width, height] of [[1024, 700], [1440, 900]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '生成视频', exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(output, `layout-${width}.png`) });
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ output, checks }));
} catch (error) {
  console.error({ output });
  if (page && !page.isClosed()) { console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000)); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  throw error;
} finally { await app?.close().catch(() => {}); }
