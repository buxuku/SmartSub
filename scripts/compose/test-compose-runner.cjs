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
const logs = [];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
const { buildAssDocument } = require('../../main/helpers/assStyleBuilder.ts');
const { DEFAULT_STYLE } = require('../../renderer/components/subtitleMerge/constants.ts');
Module._load = function (request, parent, isMain) {
  if (/\/(storeManager|logger)$/.test(request)) return { logMessage(message, level) { logs.push({ message: String(message), level }); } };
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
  const probe = file => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (error) { return error.stderr.toString(); } return ''; };
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
  assert.equal(
    logs.some(entry => entry.level === 'warning' && /自动切换 CPU 编码重试: ffmpeg exited with code 1: .*Unknown encoder 'smartsub_injected_unavailable_encoder'/s.test(entry.message)),
    true,
    'the hardware-fallback warning names the real reason instead of an empty "exited with code 1: "',
  );
  let streams = '';
  try { execFileSync(ffmpeg, ['-hide_banner', '-i', published], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (error) { streams = error.stderr.toString(); }
  assert.equal((streams.match(/Audio:/g) || []).length, 2, 'CPU fallback reuses the prepared second audio track');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing result');
  // #521: a VP9+Opus WebM source (what the yt-dlp downloader produces) cannot be re-encoded to H.264 inside a .webm
  const webm = path.join(root, 'download.webm');
  run(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', webm]);
  const burn = { mode: 'hard', subtitlePath: sub, style: { ...DEFAULT_STYLE, fontName: 'Arial' } };
  const burned = await runComposeJob({ videoPath: webm, outputPath: path.join(root, 'download_subtitled.mp4'), subtitle: burn, audio: { mode: 'keep' } }, context());
  const burnedStreams = probe(burned);
  assert.match(burnedStreams, /Video: h264/, 'a WebM source is burned to H.264 in the MP4 deliverable');
  assert.match(burnedStreams, /Audio: aac/, 'the Opus audio of a WebM source is re-encoded to AAC for the MP4 deliverable');
  const guardedDir = path.join(root, 'never-created');
  logs.length = 0;
  await assert.rejects(runComposeJob({ videoPath: webm, outputPath: path.join(guardedDir, 'download_subtitled.webm'), subtitle: burn, audio: { mode: 'keep' } }, context()), /WebM\/Ogg/);
  assert.equal(fs.existsSync(guardedDir), false, 'a rejected .webm output never creates its directory or a staging area');
  assert.equal(logs.some(entry => entry.message.startsWith('FFmpeg 命令:')), false, 'ffmpeg is never started for a rejected container');
  // The dubbing export shape (none + replace = video copy + AAC) works once the container is MP4
  const dubbed = await runComposeJob({ videoPath: webm, outputPath: path.join(root, 'download-dubbed.mp4'), subtitle: { mode: 'none' }, audio: { mode: 'replace', trackPath: voice } }, context());
  const dubbedStreams = probe(dubbed);
  assert.match(dubbedStreams, /Video: vp9/, 'the dubbing export copies the VP9 video');
  assert.match(dubbedStreams, /Audio: aac/, 'the dubbing export writes AAC');
  // #521: an odd-width yuv420p source fails libx264 with the very same "Conversion failed!"; the real reason must reach the UI and the log
  const odd = path.join(root, 'odd-width.mkv');
  run(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-vf', 'scale=853:480,format=yuv420p', '-c:v', 'ffv1', '-c:a', 'aac', '-shortest', odd]);
  assert.match(probe(odd), /Video: ffv1.*yuv420p.*853x480/, 'the fixture really is an odd-width yuv420p stream');
  progress = [];
  logs.length = 0;
  await assert.rejects(runComposeJob({ videoPath: odd, outputPath: path.join(root, 'odd_subtitled.mp4'), subtitle: burn, audio: { mode: 'keep' } }, context()), error => {
    assert.match(error.message, /^ffmpeg exited with code 1: /);
    assert.match(error.message, /width not divisible by 2 \(853x480\)/, 'the thrown error names the real reason');
    return true;
  });
  assert.match(progress.at(-1).errorMessage, /width not divisible by 2 \(853x480\)/, 'the UI error event carries the real reason');
  const stderrTail = logs.find(entry => entry.level === 'error' && entry.message.includes('Stream mapping:'));
  assert.ok(stderrTail && /width not divisible by 2/.test(stderrTail.message), 'the tail of ffmpeg stderr is logged at error level');
  // An MP4 with an embedded cover picture (YoutubeDownloader, yt-dlp --embed-thumbnail) carries a second `Video: mjpeg (attached pic)` stream.
  // Burning re-encodes every mapped video stream, so mapping the cover too made the MP4 muxer reject its h264 re-encode with a bare "Conversion failed!".
  const cover = path.join(root, 'cover.jpg');
  const coverSource = path.join(root, 'with-cover.mp4');
  run(['-f', 'lavfi', '-i', 'color=red:s=1280x720', '-frames:v', '1', '-pix_fmt', 'yuvj420p', cover]);
  run(['-i', video, '-i', sub, '-i', cover, '-map', '0:v', '-map', '0:a', '-map', '1:s', '-map', '2:v', '-c', 'copy', '-c:s', 'mov_text', '-disposition:v:1', 'attached_pic', coverSource]);
  assert.match(probe(coverSource), /Video: mjpeg.*\(attached pic\)/, 'the fixture really carries an attached cover picture');
  for (const [name, audio, extension] of [['keep', { mode: 'keep' }, 'mp4'], ['replace', { mode: 'replace', trackPath: voice }, 'mp4'], ['addTrack', { mode: 'addTrack', trackPath: voice }, 'mkv']]) {
    const covered = await runComposeJob({ videoPath: coverSource, outputPath: path.join(root, `with-cover_${name}.${extension}`), subtitle: burn, audio }, context());
    const coveredStreams = probe(covered);
    assert.equal((coveredStreams.match(/Video:/g) || []).length, 1, `${name}: only the real video stream is re-encoded`);
    assert.match(coveredStreams, /Video: h264/, `${name}: the burned video is H.264`);
    assert.doesNotMatch(coveredStreams, /attached pic/, `${name}: the cover picture is not carried into the burned output`);
  }
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
  console.log(JSON.stringify({ root, checks: 'real FFmpeg source rejection, invalid style/subtitle failure, silent-source mix with hard/soft/none and CPU fallback, injected hardware failure + CPU/addTrack retry, VP9+Opus WebM source burned to H.264+AAC MP4 and WebM/Ogg output rejected before ffmpeg or staging, dubbing-shape WebM copy to MP4, real ffmpeg failure reason (odd-width libx264) in the thrown error, UI event and error log, MP4 with an embedded cover picture burned to a single video stream (keep/replace/addTrack), hardware-fallback warning naming the unknown encoder, mid-encode cancellation, original hashes and private-directory cleanup' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; require.extensions['.ts'] = originalTs; });
