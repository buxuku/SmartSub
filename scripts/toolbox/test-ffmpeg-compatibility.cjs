const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');

// Only the Electron-owned logger is stubbed; all probes and encodes run the
// application's production modules against the bundled FFmpeg binary.
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/logger')) return { logMessage() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  cancelVideoTrim,
  executeVideoTrim,
  probeVideoInfo,
} = require('../../main/helpers/toolbox/videoTrimmer.ts');
const {
  executeVideoCompress,
} = require('../../main/helpers/toolbox/videoCompressor.ts');
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "smartsub-toolbox-兼容 ' [x],-"),
);
const failures = [];
let job = 0;

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function generate(name, args) {
  const output = path.join(root, name);
  run([...args, output]);
  return output;
}

function streams(file) {
  // Probe independently of probeVideoInfo so its parsing cannot validate itself.
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.match(result.stderr, /Input #0/);
  return result.stderr.split(/\r?\n/).filter((line) => /Stream #0:/.test(line));
}

function videoLine(file) {
  return streams(file).find(
    (line) => /Video:/.test(line) && !/attached pic/.test(line),
  );
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function trim(videoPath, mode, extra = {}) {
  const result = await executeVideoTrim(
    { videoPath, startSec: 0, endSec: 0.8, mode, ...extra },
    `compat-trim-${++job}`,
  );
  assert.equal(result.success, true, result.error);
  assert.notEqual(result.outputPath, videoPath);
  return result.outputPath;
}

async function compress(videoPath, preset, extra = {}) {
  const result = await executeVideoCompress(
    { videoPath, preset, ...extra },
    `compat-compress-${++job}`,
  );
  assert.equal(result.success, true, result.error);
  return result;
}

async function main() {
  const plain = generate('plain.mp4', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=10:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
  ]);
  const srt = path.join(root, 'captions.srt');
  fs.writeFileSync(
    srt,
    '1\n00:00:00,000 --> 00:00:00,700\nKeep these captions\n',
  );
  const ass = generate('styled.ass', ['-i', srt, '-c:s', 'ass']);
  fs.writeFileSync(
    ass,
    fs
      .readFileSync(ass, 'utf8')
      .replace('Keep these captions', '{\\pos(20,30)}Keep these captions'),
  );
  const attachment = path.join(root, 'font.bin');
  fs.writeFileSync(attachment, 'attachment bytes preserved');
  const multi = generate('multi.mkv', [
    '-i',
    plain,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1',
    '-i',
    srt,
    '-i',
    ass,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:s',
    '-map',
    '4:s',
    '-c:v',
    'copy',
    '-c:a:0',
    'aac',
    '-c:a:1',
    'pcm_s16le',
    '-c:s',
    'copy',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=zho',
    '-attach',
    attachment,
    '-metadata:s:t:0',
    'mimetype=application/octet-stream',
  ]);
  const webm = generate('captions.webm', [
    '-i',
    plain,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-i',
    srt,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:s',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-c:a',
    'libopus',
    '-c:s',
    'webvtt',
  ]);
  const ogv = generate('plain.ogv', ['-i', plain, '-c:v', 'libtheora']);
  const odd = generate('odd.mkv', [
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=321x181:rate=10:duration=1',
    '-vf',
    'format=yuv420p',
    '-c:v',
    'ffv1',
  ]);
  const rgb = generate('rgb.mkv', [
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=10:duration=1',
    '-c:v',
    'ffv1',
  ]);
  const high444 = generate('high444.mp4', [
    '-i',
    rgb,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv444p',
  ]);
  const movText = generate('mov-text.mp4', [
    '-i',
    plain,
    '-i',
    srt,
    '-map',
    '0:v',
    '-map',
    '1:s',
    '-c:v',
    'copy',
    '-c:s',
    'mov_text',
  ]);

  await check(
    'probe reports every audio codec in input order and the video pixel format',
    async () => {
      const info = await probeVideoInfo(multi);
      assert.deepEqual(info.audioCodecs, ['aac', 'pcm_s16le']);
      assert.equal(info.audioCodec, 'aac');
      assert.equal(info.pixelFormat, 'yuv420p');
      assert.deepEqual((await probeVideoInfo(plain)).audioCodecs, []);
    },
  );
  await check(
    'accurate WebM trim chooses MP4 and retains its WebVTT captions as mov_text',
    async () => {
      const output = await trim(webm, 'accurate');
      assert.equal(path.extname(output), '.mp4');
      const outputStreams = streams(output);
      assert.equal(
        outputStreams.filter((line) => /Audio:/.test(line)).length,
        1,
      );
      assert.match(
        outputStreams.find((line) => /Subtitle:/.test(line)),
        /mov_text/,
      );
      assert.match(videoLine(output), /h264.*yuv420p/);
    },
  );
  await check(
    'accurate Ogg video trim chooses a compatible container',
    async () => {
      assert.equal(path.extname(await trim(ogv, 'accurate')), '.mp4');
    },
  );
  await check(
    'accurate odd yuv420p trim pads without discarding source pixels',
    async () => {
      assert.match(videoLine(await trim(odd, 'accurate')), /yuv420p.*322x182/);
    },
  );
  for (const preset of [
    'wechat_25mb',
    'target_size',
    'fast_720p',
    'balanced_1080p',
  ]) {
    await check(`${preset} compresses odd yuv420p dimensions`, async () => {
      const result = await compress(odd, preset, { targetSizeMb: 1 });
      const line = videoLine(result.outputPath);
      assert.match(line, /yuv420p/);
      const [, width, height] = line.match(/,\s*(\d+)x(\d+)(?:[\s,]|$)/);
      assert.equal(Number(width) % 2, 0);
      assert.equal(Number(height) % 2, 0);
    });
  }
  await check(
    'lossless trim retains both audio tracks, both subtitles and attachment',
    async () => {
      const output = await trim(multi, 'lossless');
      const lines = streams(output);
      assert.equal(lines.filter((line) => /Audio:/.test(line)).length, 2);
      assert.equal(lines.filter((line) => /Subtitle:/.test(line)).length, 2);
      assert.equal(lines.filter((line) => /Attachment:/.test(line)).length, 1);
      assert.match(
        lines.find((line) => /pcm_s16le/.test(line)),
        /\(zho\)/,
      );
    },
  );
  await check(
    'accurate MKV trim preserves native ASS positions and attachment bytes',
    async () => {
      const output = await trim(multi, 'accurate');
      const lines = streams(output);
      assert.equal(lines.filter((line) => /Audio:/.test(line)).length, 2);
      assert.equal(lines.filter((line) => /Subtitle:/.test(line)).length, 2);
      assert.equal(lines.filter((line) => /Attachment:/.test(line)).length, 1);
      const extracted = generate('retained.ass', [
        '-i',
        output,
        '-map',
        '0:s:1',
        '-c:s',
        'copy',
      ]);
      assert.match(fs.readFileSync(extracted, 'utf8'), /\\pos\(20,30\)/);
      const dumped = path.join(root, 'retained.bin');
      run([
        '-dump_attachment:t:0',
        dumped,
        '-i',
        output,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ]);
      assert.deepEqual(fs.readFileSync(dumped), fs.readFileSync(attachment));
    },
  );
  await check('accurate MP4 trim retains mov_text subtitles', async () => {
    const output = await trim(movText, 'accurate');
    assert.match(
      streams(output).find((line) => /Subtitle:/.test(line)),
      /mov_text/,
    );
  });
  await check(
    'accurate mov_text to MKV trim converts captions to a supported codec',
    async () => {
      const output = await trim(movText, 'accurate', {
        outputPath: path.join(root, 'converted.mkv'),
      });
      assert.match(
        streams(output).find((line) => /Subtitle:/.test(line)),
        /subrip/,
      );
      const extracted = generate('retained.srt', [
        '-i',
        output,
        '-map',
        '0:s:0',
        '-c:s',
        'srt',
      ]);
      assert.match(fs.readFileSync(extracted, 'utf8'), /Keep these captions/);
    },
  );
  await check(
    'RGB compression produces an 8-bit 4:2:0 H.264 stream',
    async () => {
      assert.match(
        videoLine((await compress(rgb, 'fast_720p')).outputPath),
        /h264.*yuv420p/,
      );
    },
  );
  await check(
    'size-only compression does not skip a small yuv444p H.264 MP4',
    async () => {
      const result = await compress(high444, 'wechat_25mb');
      assert.notEqual(result.skipped, true);
      assert.notEqual(result.outputPath, high444);
      assert.match(videoLine(result.outputPath), /yuv420p/);
    },
  );
  await check(
    'compatible silent H.264/yuv420p MP4 still skips size-only compression',
    async () => {
      assert.equal((await compress(plain, 'wechat_25mb')).skipped, true);
    },
  );
  await check(
    'accurate trim and compression select real video instead of a larger attached picture',
    async () => {
      const picture = generate('cover.png', [
        '-f',
        'lavfi',
        '-i',
        'color=red:size=640x360',
        '-frames:v',
        '1',
      ]);
      const covered = generate('covered.mp4', [
        '-i',
        plain,
        '-i',
        picture,
        '-map',
        '0:v',
        '-map',
        '1:v',
        '-c',
        'copy',
        '-disposition:v:1',
        'attached_pic',
      ]);
      assert.match(videoLine(await trim(covered, 'accurate')), /320x180/);
      assert.match(
        videoLine((await compress(covered, 'fast_720p')).outputPath),
        /320x180/,
      );
    },
  );
  await check(
    'cancelling accurate trim during subtitle probing leaves no output',
    async () => {
      const jobId = `compat-cancel-${++job}`;
      const outputPath = path.join(root, 'cancelled.mp4');
      const pending = executeVideoTrim(
        {
          videoPath: plain,
          startSec: 0,
          endSec: 0.8,
          mode: 'accurate',
          outputPath,
        },
        jobId,
      );
      assert.equal(cancelVideoTrim(jobId), true);
      const result = await pending.catch(() => ({ success: false }));
      assert.equal(result.success, false);
      assert.equal(fs.existsSync(outputPath), false);
      assert.equal(cancelVideoTrim(jobId), false);
    },
  );
  assert.deepEqual(
    failures,
    [],
    `${failures.length} FFmpeg compatibility regressions failed; fixtures: ${root}`,
  );
  console.log('Toolbox real FFmpeg compatibility regressions passed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
    if (!process.exitCode) fs.rmSync(root, { recursive: true, force: true });
  });
