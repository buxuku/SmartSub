const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');
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
  if (/\/(storeManager|logger)$/.test(request)) return { logMessage() {} };
  if (request.endsWith('/fileUtils'))
    return {
      timemarkToSeconds: (value) =>
        String(value || '')
          .split(':')
          .reduce((sum, n) => sum * 60 + Number(n), 0),
    };
  return originalLoad.call(this, request, parent, isMain);
};

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "smartsub-streams-O'Brien [字幕], draft;-"),
);
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const probe = (file) =>
  spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
const failures = [];
async function check(name, test) {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function main() {
  const {
    runComposeJob,
  } = require('../../main/helpers/compose/composeRunner.ts');
  const {
    buildComposePlan,
  } = require('../../main/helpers/compose/composeCommandBuilder.ts');
  const {
    DEFAULT_STYLE,
  } = require('../../renderer/components/subtitleMerge/constants.ts');
  const { buildAssDocument } = require('../../main/helpers/assStyleBuilder.ts');
  const video = path.join(root, 'video.mp4');
  const text = path.join(root, 'new.srt');
  const native = path.join(root, 'native.ass');
  const voice = path.join(root, 'voice.wav');
  fs.writeFileSync(text, '1\n00:00:00,000 --> 00:00:00,900\nNew subtitle\n');
  fs.writeFileSync(
    native,
    buildAssDocument([{ startMs: 0, endMs: 1000, text: 'Original ASS' }], {
      ...DEFAULT_STYLE,
      fontName: 'Arial',
      alignment: 5,
    }),
  );
  run([
    '-f',
    'lavfi',
    '-i',
    'color=black:s=320x240:r=10:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    video,
  ]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', voice]);
  const movtext = path.join(root, 'movtext.mp4');
  const mixed = path.join(root, 'mixed.mkv');
  const assVideo = path.join(root, 'native.mkv');
  const attachment = path.join(root, 'font-fixture.ttf');
  fs.writeFileSync(attachment, 'font attachment preservation fixture');
  run([
    '-i',
    video,
    '-i',
    text,
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    movtext,
  ]);
  run([
    '-i',
    video,
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '0:a',
    '-c:v',
    'copy',
    '-c:a:0',
    'copy',
    '-c:a:1',
    'pcm_s16le',
    mixed,
  ]);
  run([
    '-i',
    video,
    '-i',
    native,
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-attach',
    attachment,
    '-metadata:s:t:0',
    'mimetype=application/x-truetype-font',
    assVideo,
  ]);
  let id = 0;
  const compose = (src, ext, subtitle, audio = { mode: 'keep' }) =>
    runComposeJob(
      {
        videoPath: src,
        outputPath: path.join(root, `output-${++id}.${ext}`),
        subtitle,
        audio,
      },
      { jobId: `stream-${id}`, setCancel() {} },
    );
  const soft = { mode: 'soft', subtitlePath: text };
  const hard = {
    mode: 'hard',
    subtitlePath: text,
    style: { ...DEFAULT_STYLE, fontName: 'Arial' },
  };

  await check('MP4 mov_text survives soft subtitle export to MKV', async () => {
    const out = await compose(movtext, 'mkv', soft);
    assert.equal((probe(out).match(/Subtitle: subrip/g) || []).length, 2);
  });
  await check('MP4 mov_text survives adding a voice track in MKV', async () => {
    const out = await compose(
      movtext,
      'mkv',
      { mode: 'none' },
      { mode: 'addTrack', trackPath: voice },
    );
    const streams = probe(out);
    assert.match(streams, /Subtitle: subrip/);
    assert.equal((streams.match(/Audio:/g) || []).length, 2);
  });
  for (const subtitle of [hard, soft])
    await check(
      `${subtitle.mode}: incompatible audio becomes AAC while existing AAC stays copied`,
      async () => {
        const out = await compose(mixed, 'mp4', subtitle);
        assert.equal((probe(out).match(/Audio: aac/g) || []).length, 2);
        const packets = (file) =>
          run([
            '-i',
            file,
            '-map',
            '0:a:0',
            '-c:a',
            'copy',
            '-f',
            'adts',
            'pipe:1',
          ]);
        assert.deepEqual(
          packets(out),
          packets(mixed),
          'compatible AAC packets are retained',
        );
      },
    );
  await check(
    'native ASS is preserved in MKV with a new subtitle',
    async () => {
      const out = await compose(assVideo, 'mkv', soft);
      assert.match(probe(out), /Subtitle: ass/);
      const content = run([
        '-i',
        out,
        '-map',
        '0:s:1',
        '-c:s',
        'copy',
        '-f',
        'ass',
        'pipe:1',
      ]).toString();
      assert.match(content, /Original ASS/);
      assert.match(content, /Arial/);
    },
  );
  await check(
    'native ASS is converted when replacing audio into MP4',
    async () => {
      const out = await compose(
        assVideo,
        'mp4',
        { mode: 'none' },
        { mode: 'replace', trackPath: voice },
      );
      assert.match(probe(out), /Subtitle: mov_text/);
    },
  );
  await check(
    'bitmap subtitles cannot be silently copied into MP4',
    async () => {
      assert.throws(
        () =>
          buildComposePlan({
            videoPath: 'input.mkv',
            outputPath: 'output.mp4',
            subtitle: { mode: 'none' },
            audio: { mode: 'replace', trackPath: 'voice.wav' },
            embeddedSubtitles: [
              {
                subIndex: 0,
                codec: 'hdmv_pgs_subtitle',
                isText: false,
                isDefault: true,
                isForced: false,
              },
            ],
          }),
        /bitmap.*MKV/i,
      );
    },
  );
  await check('translated native ASS keeps CPU output yuv420p', async () => {
    const out = await compose(video, 'mp4', {
      mode: 'hard',
      subtitlePath: native,
      style: {
        ...DEFAULT_STYLE,
        fontName: 'Arial',
        alignment: 5,
        positionY: 60,
      },
    });
    assert.match(probe(out), /Video: h264.*yuv420p/);
    const frame = run([
      '-i',
      out,
      '-ss',
      '0.5',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.ok(
      frame.some((value) => value > 128),
      'subtitle pixels are present',
    );
  });
  for (const mode of ['replace', 'mix'])
    await check(
      `${mode}: copied ASS retains MKV font attachments`,
      async () => {
        const out = await compose(
          assVideo,
          'mkv',
          { mode: 'none' },
          { mode, trackPath: voice },
        );
        assert.match(probe(out), /Attachment: ttf/);
        const dumped = path.join(root, `attachment-${mode}.ttf`);
        run([
          '-dump_attachment:t:0',
          dumped,
          '-i',
          out,
          '-t',
          '0.1',
          '-f',
          'null',
          '-',
        ]);
        assert.deepEqual(fs.readFileSync(dumped), fs.readFileSync(attachment));
      },
    );
  await check(
    'streamable media without duration still supports compose',
    async () => {
      const live = path.join(root, 'live.webm');
      run([
        '-i',
        video,
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-live',
        '1',
        live,
      ]);
      assert.match(probe(live), /Duration: N\/A/);
      const {
        probeVideoInfo,
      } = require('../../main/helpers/toolbox/videoTrimmer.ts');
      await assert.rejects(
        probeVideoInfo(live),
        /duration/i,
        'duration-dependent toolbox operations still reject unknown duration',
      );
      for (const subtitle of [hard, soft, { mode: 'none' }]) {
        const out = await compose(live, 'mkv', subtitle, {
          mode: 'replace',
          trackPath: voice,
        });
        assert.match(probe(out), /Video:/);
        assert.match(probe(out), /Audio: aac/);
      }
    },
  );
  assert.deepEqual(
    failures,
    [],
    'all real FFmpeg compatibility cases must pass',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
    fs.rmSync(root, { recursive: true, force: true });
  });
