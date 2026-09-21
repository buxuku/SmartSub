const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
const { buildAssDocument } = require('../../main/helpers/assStyleBuilder.ts');
const { DEFAULT_STYLE } = require('../../renderer/components/subtitleMerge/constants.ts');
Module._load = function (request, parent, isMain) {
  if (/\/(storeManager|logger)$/.test(request)) return { logMessage() {} };
  if (request.endsWith('/fileUtils')) return { timemarkToSeconds: value => value.split(':').reduce((total, n) => total * 60 + Number(n), 0) };
  if (request.endsWith('/subtitleMerger')) return {
    MERGE_CANCELLED: 'MERGE_CANCELLED',
    getVideoInfo: async () => ({ width: 640, height: 360, duration: 3 }),
    buildAssForSubtitle: (_text, _file, style) => ({ assContent: buildAssDocument([{ startMs: 0, endMs: 3000, text: 'Runner' }], style), effectiveStyle: style }),
    escapeSubtitlePath: value => value.replace(/\\/g, '/').replace(/:/g, '\\:'),
    cleanupTempSubtitle: value => fs.rmSync(value, { force: true }),
  };
  if (request.endsWith('/hwEncoderDetector')) return {
    getHwAccelInfo: async () => ({ available: true, encoderId: 'h264_nvenc', rateMode: 'cq' }),
    buildHwCqArgs: () => ['-c:v', 'smartsub_injected_unavailable_encoder'],
  };
  return originalLoad.call(this, request, parent, isMain);
};
async function main() {
  const { runComposeJob } = require('../../main/helpers/compose/composeRunner.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-compose-runner-'));
  const video = path.join(root, 'input.mp4');
  const sub = path.join(root, 'input.srt');
  const voice = path.join(root, 'voice.wav');
  const existing = path.join(root, 'result.mkv');
  const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
  run(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', voice]);
  fs.writeFileSync(sub, '1\n00:00:00,100 --> 00:00:02,900\nRunner\n');
  fs.writeFileSync(existing, 'existing result');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(video);
  let cancel;
  let progress = [];
  const context = () => ({ jobId: 'runner-test', setCancel: fn => { cancel = fn; }, onProgress: event => progress.push(event) });
  const base = { videoPath: video, outputPath: existing, subtitle: { mode: 'soft', subtitlePath: sub }, audio: { mode: 'keep' } };
  await assert.rejects(runComposeJob({ ...base, outputPath: video }, context()), /input file/);
  await assert.rejects(runComposeJob({ ...base, subtitle: { mode: 'hard', subtitlePath: sub, style: { ...DEFAULT_STYLE, primaryColor: '#F', fontSize: -1 } } }, context()), /Invalid subtitle style/);
  const invalid = path.join(root, 'broken.srt'); fs.writeFileSync(invalid, 'broken');
  await assert.rejects(runComposeJob({ ...base, subtitle: { mode: 'soft', subtitlePath: invalid } }, context()));
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing result');
  const silent = path.join(root, 'silent.mp4');
  run(['-i', video, '-an', '-c:v', 'copy', silent]);
  for (const subtitle of [{ mode: 'soft', subtitlePath: sub }, { mode: 'hard', subtitlePath: sub, style: DEFAULT_STYLE, encoderMode: 'hardware' }, { mode: 'none' }]) {
    const mixed = await runComposeJob({ ...base, videoPath: silent, outputPath: path.join(root, `silent-${subtitle.mode}.mkv`), subtitle, audio: { mode: 'mix', trackPath: voice } }, context());
    let metadata = '';
    try { execFileSync(ffmpeg, ['-hide_banner', '-i', mixed], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (error) { metadata = error.stderr.toString(); }
    assert.equal((metadata.match(/Audio:/g) || []).length, 1, `${subtitle.mode}: silent source mixes to one voice track`);
  }
  assert.equal(hash(video), before);
  progress = [];
  const published = await runComposeJob({ ...base, subtitle: { mode: 'hard', subtitlePath: sub, style: { ...DEFAULT_STYLE, fontName: 'Arial' }, encoderMode: 'hardware' }, audio: { mode: 'addTrack', trackPath: voice } }, context());
  assert.equal(published, path.join(root, 'result_2.mkv'));
  assert.equal(progress.some(event => event.hwFallback), true, 'injected unavailable encoder takes actual CPU retry');
  let streams = '';
  try { execFileSync(ffmpeg, ['-hide_banner', '-i', published], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (error) { streams = error.stderr.toString(); }
  assert.equal((streams.match(/Audio:/g) || []).length, 2, 'CPU fallback reuses the prepared second audio track');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing result');
  const long = path.join(root, 'long.mp4');
  run(['-stream_loop', '399', '-i', video, '-c', 'copy', long]);
  let cancelled = false;
  await assert.rejects(runComposeJob({ ...base, videoPath: long, subtitle: { mode: 'hard', subtitlePath: sub, style: { ...DEFAULT_STYLE, fontName: 'Arial' } } }, {
    ...context(), onProgress: event => { if (!cancelled && event.percent > 0 && event.status === 'processing') { cancelled = true; cancel(); } },
  }), /MERGE_CANCELLED/);
  assert.equal(cancelled, true);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing result');
  assert.equal(hash(video), before);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.smartsub-compose-')), false);
  console.log(JSON.stringify({ root, checks: 'real FFmpeg source rejection, invalid style/subtitle failure, silent-source mix with hard/soft/none and CPU fallback, injected hardware failure + CPU/addTrack retry, mid-encode cancellation, original hashes and private-directory cleanup' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; require.extensions['.ts'] = originalTs; });
