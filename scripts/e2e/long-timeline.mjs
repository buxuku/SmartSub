import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';

const evidence = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-timeline-e2e-'),
);
const video = path.join(evidence, 'two-hour-24000-1001.mp4');
const source = path.join(evidence, '24fps.srt');
const frames = 172800;
const starts = [24, 86400, 172608];
const format = (ms) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
const expected = starts.map((frame) => ({
  start: (frame * 1001) / 24,
  end: ((frame + 48) * 1001) / 24,
}));
const subtitle = starts
  .map(
    (frame, i) =>
      `${i + 1}\n${format((frame * 1000) / 24)} --> ${format(((frame + 48) * 1000) / 24)}\nSYNC ${i + 1}\n`,
  )
  .join('\n');
await fs.writeFile(source, subtitle);
async function run(args, binary = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', ...args]);
    const out = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(binary ? Buffer.concat(out) : stderr)
        : reject(new Error(stderr.slice(-6000))),
    );
  });
}
console.log(
  `Timeline evidence: ${evidence}; generating 172800 frames at 24000/1001 fps`,
);
await run([
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=320x180:r=24000/1001',
  '-frames:v',
  String(frames),
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  video,
]);
let app;
let page;
try {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${path.join(evidence, 'profile')}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.closeDevTools();
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const synced = await page.evaluate(
    ({ source, evidence }) =>
      window.ipc.invoke('toolbox:syncSubtitleTime', {
        filePath: source,
        outputPath: `${evidence}/synced.srt`,
        mode: 'scale',
        scaleRatio: 1001 / 1000,
        scaleFraction: { numerator: 1001, denominator: 1000 },
      }),
    { source, evidence },
  );
  assert.equal(synced.success, true, JSON.stringify(synced));
  const timings = (text) =>
    [
      ...text.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g),
    ].map((match) => [match[1], match[2]]);
  assert.deepEqual(
    timings(await fs.readFile(synced.outputPath, 'utf8')),
    expected.map(({ start, end }) => [format(start), format(end)]),
  );
  console.log(
    'Subtitle scaling exact at first, middle and final cue; running production compressor',
  );
  const compressed = await page.evaluate(
    ({ video, evidence }) =>
      window.ipc.invoke('toolbox:compressVideo', {
        jobId: 'long-timeline-compress',
        config: {
          videoPath: video,
          outputPath: `${evidence}/compressed.mp4`,
          preset: 'fast_720p',
        },
      }),
    { video, evidence },
  );
  assert.equal(compressed.success, true, JSON.stringify(compressed));
  const style = {
    fontName: 'Arial',
    fontSize: 18,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    backColor: '#000000',
    backOpacity: 0,
    bold: false,
    italic: false,
    underline: false,
    borderStyle: 1,
    outline: 0,
    shadow: 0,
    alignment: 2,
    marginL: 5,
    marginR: 5,
    marginV: 10,
  };
  console.log('Production compression complete; burning full two-hour video');
  const hard = await page.evaluate(
    (config) => window.ipc.invoke('subtitleMerge:startMerge', config),
    {
      videoPath: compressed.outputPath,
      subtitlePath: synced.outputPath,
      outputPath: path.join(evidence, 'hard.mp4'),
      style,
      outputMode: 'hardcode',
      videoQuality: 'original',
      encoderMode: 'cpu',
    },
  );
  assert.equal(hard.success, true, JSON.stringify(hard));
  const soft = await page.evaluate(
    (config) => window.ipc.invoke('subtitleMerge:startMerge', config),
    {
      videoPath: compressed.outputPath,
      subtitlePath: synced.outputPath,
      outputPath: path.join(evidence, 'soft.mkv'),
      style,
      outputMode: 'softmux',
    },
  );
  assert.equal(soft.success, true, JSON.stringify(soft));
  await run([
    '-loglevel',
    'error',
    '-i',
    soft.data,
    '-map',
    '0:s:0',
    '-c:s',
    'srt',
    path.join(evidence, 'extracted.srt'),
  ]);
  assert.deepEqual(
    timings(await fs.readFile(path.join(evidence, 'extracted.srt'), 'utf8')),
    expected.map(({ start, end }) => [format(start), format(end)]),
  );
  const timestamps = [];
  for (const file of [video, compressed.outputPath, hard.data]) {
    console.log(`Checking decoded frame timestamps: ${path.basename(file)}`);
    const log = (
      await run(
        [
          '-loglevel',
          'error',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-an',
          '-vsync',
          '0',
          '-c:v',
          'rawvideo',
          '-f',
          'framecrc',
          '-',
        ],
        true,
      )
    ).toString();
    const timebase = log.match(/#tb 0: (\d+)\/(\d+)/);
    assert.ok(timebase, 'decoder reports exact time base');
    const pts = log
      .split('\n')
      .filter((line) => /^0,/.test(line))
      .map((line) => BigInt(line.split(',')[2].trim()));
    assert.equal(pts.length, frames, 'every decoded frame retained');
    for (const [frame, value] of pts.entries())
      assert.equal(
        value * BigInt(timebase[1]) * 24000n,
        BigInt(frame) * 1001n * BigInt(timebase[2]),
        'every decoded PTS equals exact frame index, without accumulated drift',
      );
    timestamps.push({
      file: path.basename(file),
      timebase: `${timebase[1]}/${timebase[2]}`,
      verifiedFrames: pts.length,
      samplePts: [pts[0], pts[86400], pts[frames - 1]].map(String),
    });
  }
  const sampleFrames = starts.flatMap((frame) => [
    frame - 1,
    frame + 1,
    frame + 47,
    frame + 49,
  ]);
  const raw = await run(
    [
      '-loglevel',
      'error',
      '-i',
      hard.data,
      '-an',
      '-vf',
      `select='${sampleFrames.map((frame) => `eq(n,${frame})`).join('+')}'`,
      '-vsync',
      '0',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-',
    ],
    true,
  );
  const bytes = 320 * 180;
  assert.equal(raw.length, sampleFrames.length * bytes);
  const pixels = sampleFrames.map((frame, i) => {
    let bright = 0;
    for (const value of raw.subarray(i * bytes, (i + 1) * bytes))
      if (value > 160) bright++;
    assert.equal(
      bright > 20,
      i % 4 === 1 || i % 4 === 2,
      `subtitle visible only inside cue, frame ${frame}`,
    );
    return { frame, bright };
  });
  await run([
    '-loglevel',
    'error',
    '-ss',
    String(expected[2].start / 1000 + 0.5),
    '-i',
    hard.data,
    '-frames:v',
    '1',
    path.join(evidence, 'final-cue.png'),
  ]);
  assert.equal(
    await fs.readFile(source, 'utf8'),
    subtitle,
    'source subtitle untouched',
  );
  await fs.writeFile(
    path.join(evidence, 'report.json'),
    JSON.stringify(
      {
        duration: (frames * 1001) / 24000,
        frames,
        fps: '24000/1001',
        expected,
        timestamps,
        pixels,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      success: true,
      evidence,
      duration: (frames * 1001) / 24000,
      frames,
      checks: [
        'rational subtitle export',
        'full production compression',
        'full production hard burn and soft mux',
        'exact PTS for all decoded frames',
        'soft subtitle millisecond times',
        'pixel checks before/inside/after first/middle/final cues',
        'source unchanged',
      ],
    }),
  );
} finally {
  await app?.close().catch(() => {});
}
