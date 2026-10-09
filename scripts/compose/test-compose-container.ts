import assert from 'node:assert/strict';
import {
  assertComposeOutputWritable,
  isComposeContainerWritable,
  sourceAudioNeedsAac,
  writableComposeExtension,
} from '../../types/composeContainer';
import {
  summarizeFfmpegFailure,
  withFfmpegFailureReason,
} from '../../main/helpers/compose/ffmpegFailure';
import * as failures from './ffmpeg-failure-fixtures';

/**
 * #521：合成引擎的每种成片形态都写 H.264（硬烧重编码）或 AAC（配音换轨/混音），
 * 而 WebM/Ogg muxer 只接受 VP8/VP9/AV1 + Vorbis/Opus（ffmpeg 6.0 实测）。
 * 容器可写性是主进程（队列、命令构建、默认路径）与渲染层共用的纯函数。
 *
 * 同一个 issue 里用户只看到 "Conversion failed!"：fluent-ffmpeg 的 err.message 丢掉了
 * 带 `[xxx @ 0x…]` 前缀的真实原因行。后半部分用真实抓到的 stderr 验证失败原因的提取。
 */

// ── isComposeContainerWritable：黑名单只含已验证会拒绝 H.264 的容器 ────────────

for (const extension of ['.webm', '.WEBM', '.WebM', '.ogv', '.ogg', '.OGG']) {
  assert.equal(
    isComposeContainerWritable(extension),
    false,
    `${extension} cannot hold H.264/AAC`,
  );
}
for (const extension of [
  '.mp4',
  '.MP4',
  '.mkv',
  '.mov',
  '.m4v',
  '.avi',
  '.flv',
  '.ts',
  '.mts',
  '.m2ts',
  '.3gp',
  '.wmv',
  '.asf',
  '.vob',
  '.rm',
  '.rmvb',
  '',
]) {
  assert.equal(
    isComposeContainerWritable(extension),
    true,
    `${extension || '(none)'} keeps its existing behaviour`,
  );
}
// 调用方可能直接传不带点的写法
assert.equal(isComposeContainerWritable('webm'), false);
assert.equal(isComposeContainerWritable('mp4'), true);

// ── writableComposeExtension：可写的原样返回（保留大小写），其余回落 .mp4 ─────

for (const [input, expected] of [
  ['.webm', '.mp4'],
  ['.WEBM', '.mp4'],
  ['.ogv', '.mp4'],
  ['.ogg', '.mp4'],
  ['.mp4', '.mp4'],
  ['.MP4', '.MP4'],
  ['.mkv', '.mkv'],
  ['.MKV', '.MKV'],
  ['.mov', '.mov'],
  ['.avi', '.avi'],
  ['', ''],
] as const) {
  assert.equal(
    writableComposeExtension(input),
    expected,
    `${input || '(none)'} -> ${expected || '(none)'}`,
  );
}

// ── assertComposeOutputWritable：引擎入口的拒绝，错误信息给出可操作的修复办法 ──

for (const rejected of [
  '/v/clip_subtitled.webm',
  'C:\\Videos\\SmartSub\\clip_subtitled.webm',
  '/v/CLIP.WEBM',
  '/v/a.ogv',
  '/v/a.ogg',
]) {
  assert.throws(
    () => assertComposeOutputWritable(rejected),
    (error: unknown) =>
      error instanceof Error &&
      /WebM\/Ogg/.test(error.message) &&
      /\.mp4/.test(error.message) &&
      /\.mkv/.test(error.message),
    `${rejected} must be rejected with guidance`,
  );
}
assert.throws(
  () => assertComposeOutputWritable('/v/clip_subtitled.webm'),
  /"\.webm"/,
  'the message names the offending extension',
);
for (const accepted of [
  '/v/out.mp4',
  '/v/out.mkv',
  '/v/out.MOV',
  '/v/no-extension',
  // 只看最后一段文件名：目录名里的 .webm 不是容器
  'C:\\a.webm\\out.mp4',
  '/v/dir.webm/out.mkv',
  '/v/dir.webm/no-extension',
]) {
  assert.doesNotThrow(
    () => assertComposeOutputWritable(accepted),
    `${accepted} is writable`,
  );
}

// ── sourceAudioNeedsAac：仅 WebM/Ogg 源 → MP4 系输出时，音频才需转 AAC ────────

for (const [source, output, expected] of [
  ['.webm', '.mp4', true],
  ['.WEBM', '.MP4', true],
  ['.webm', '.mov', true],
  ['.webm', '.m4v', true],
  ['.ogv', '.mp4', true],
  ['.ogg', '.mp4', true],
  // 用户手动选 .mkv：Matroska 接受 Opus/Vorbis，保持直拷
  ['.webm', '.mkv', false],
  // 其余组合保持既有的 -c:a copy
  ['.mp4', '.mp4', false],
  ['.mkv', '.mp4', false],
  ['.mov', '.mp4', false],
  ['.avi', '.mp4', false],
  ['.mp4', '.mkv', false],
  ['', '.mp4', false],
] as const) {
  assert.equal(
    sourceAudioNeedsAac(source, output),
    expected,
    `${source || '(none)'} -> ${output}: AAC=${expected}`,
  );
}

// ── summarizeFfmpegFailure：从真实 stderr 里取出失败原因 ──────────────────────
// 夹具是 ffmpeg 6.0 经 fluent-ffmpeg 实际跑出来的输出（scripts/compose/ffmpeg-failure-fixtures.ts）：
// 带版本横幅、缩进的输入元数据、`@ 0x…` 地址、失败之后的 Qavg 信息行与 "Conversion failed!"。

const WEBM_MUXER_REJECTION =
  '[webm] Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.';
const WEBM_HEADER_FAILURE =
  '[out#0/webm] Could not write header (incorrect codec parameters ?): Invalid argument';

for (const [label, fixture, expected] of [
  [
    '#521 original: H.264 burn into .webm',
    failures.WEBM_H264_BURN,
    [
      WEBM_MUXER_REJECTION,
      WEBM_HEADER_FAILURE,
      '[vost#0:0/libx264] Error initializing output stream:',
    ],
  ],
  [
    'dubbing export (video copy + AAC) into .webm; trailing Qavg line is not part of the reason',
    failures.DUBBING_REPLACE_WEBM,
    [
      WEBM_MUXER_REJECTION,
      WEBM_HEADER_FAILURE,
      '[aost#0:1/aac] Error initializing output stream:',
    ],
  ],
  [
    'odd-width yuv420p: the screenshot-identical "Conversion failed!" has a different cause',
    failures.ODD_WIDTH_H264,
    [
      '[libx264] width not divisible by 2 (853x480)',
      '[vost#0:0/libx264] Error initializing output stream: Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height',
    ],
  ],
  [
    'missing .ass: the root cause is the top of a six-line cascade, followed by Qavg/queue chatter',
    failures.BAD_ASS_PATH,
    [
      '[Parsed_ass_0] ass_read_file(/tmp/smartsub-521/missing.ass): fopen failed',
      "[Parsed_ass_0] Could not create a libass track when reading file '/tmp/smartsub-521/missing.ass'",
      '[AVFilterGraph] Error initializing filters',
      'Error reinitializing filters!',
      'Failed to inject frame into filter network: Invalid argument',
      'Error while processing the decoded data for stream #0:0',
    ],
  ],
  [
    'unknown encoder (fluent-ffmpeg left the message empty)',
    failures.UNKNOWN_ENCODER,
    ["[vost#0:0] Unknown encoder 'h264_nvenc'"],
  ],
  [
    'missing output directory (a cause line without a [ prefix)',
    failures.OUTPUT_DIR_MISSING,
    ['/tmp/smartsub-521/no-such-dir/out5.mp4: No such file or directory'],
  ],
  [
    'corrupt input: the keyword-less "low score" info line is not part of the reason',
    failures.CORRUPT_INPUT,
    [
      '[mov,mp4,m4a,3gp,3g2,mj2] moov atom not found',
      '/tmp/smartsub-521/garbage.mp4: Invalid data found when processing input',
    ],
  ],
  [
    'no keyword in the cause line; the indented title metadata ("Error budget review - failed rollout") is not picked',
    failures.NO_STREAMS,
    ['[out#0/mp4] Output file does not contain any stream'],
  ],
  [
    'write fails mid-encode (exit code 224): libass/CoreText chatter splits the cause and x264 statistics follow it',
    failures.BROKEN_PIPE_AMID_CHATTER,
    [
      'av_interleaved_write_frame(): Broken pipe',
      '[out#0/mpegts] Error muxing a packet',
      '[out#0/mpegts] Error writing trailer: Broken pipe',
    ],
  ],
] as const) {
  assert.equal(
    summarizeFfmpegFailure(fixture.stderr),
    expected.join('\n'),
    label,
  );
}

// 摘要不含 "Conversion failed!" 之类的包装行，也不含 `0x…` 地址
for (const fixture of Object.values(failures)) {
  const summary = summarizeFfmpegFailure(fixture.stderr);
  assert.doesNotMatch(summary, /Conversion failed/);
  assert.doesNotMatch(summary, /0x[0-9a-f]{6,}/i);
  assert.notEqual(summary, '', 'every real failure yields a reason');
}

// 空输入与只有包装行的输入没有原因可报
for (const empty of [undefined, null, '', '   \n\n  ']) {
  assert.equal(summarizeFfmpegFailure(empty), '', `${String(empty)} -> ''`);
}
assert.equal(summarizeFfmpegFailure('Conversion failed!\n'), '');
assert.equal(
  summarizeFfmpegFailure(
    'Fontconfig error: Cannot load default config file: No such file: (null)\nConversion failed!',
  ),
  '',
  'fontconfig noise is not a failure reason',
);

// Windows：CRLF 换行，地址不带 0x 前缀
assert.equal(
  summarizeFfmpegFailure(
    [
      'ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers',
      '[libx264 @ 000001F2A3B4C5D6] width not divisible by 2 (853x480)',
      '[vost#0:0/libx264 @ 000001F2A3B4D010] Error initializing output stream: Error while opening encoder',
      'Conversion failed!',
    ].join('\r\n'),
  ),
  [
    '[libx264] width not divisible by 2 (853x480)',
    '[vost#0:0/libx264] Error initializing output stream: Error while opening encoder',
  ].join('\n'),
  'CRLF output and 0x-less addresses (Windows)',
);

// ffmpeg 用裸 CR 覆盖刷新进度行：进度与紧随其后的原因行必须被拆开
assert.equal(
  summarizeFfmpegFailure(
    'frame=  100 fps= 50 q=28.0 size=     256kB time=00:00:04.00 bitrate= 524.3kbits/s speed=2.0x    \r[libx264 @ 0x5581a1b2c3d0] width not divisible by 2 (853x480)\nConversion failed!',
  ),
  '[libx264] width not divisible by 2 (853x480)',
  'a progress line overwritten with a bare CR does not swallow the reason',
);

// 夹在原因行中间的噪声行不截断原因簇
assert.equal(
  summarizeFfmpegFailure(
    [
      '[mp4 @ 0x5581a1b2c3d0] Could not write header (incorrect codec parameters ?): Invalid argument',
      'Fontconfig error: Cannot load default config file: No such file: (null)',
      '[vost#0:0 @ 0x5581a1b2c4e0] Error initializing output stream:',
      'Conversion failed!',
    ].join('\n'),
  ),
  [
    '[mp4] Could not write header (incorrect codec parameters ?): Invalid argument',
    '[vost#0:0] Error initializing output stream:',
  ].join('\n'),
  'noise lines inside the cluster are skipped, not treated as its end',
);

// 没有关键词的原因行之后跟着编码器收尾的 Qavg/队列信息行：回退时只展示原因本身
assert.equal(
  summarizeFfmpegFailure(
    [
      '[mp4 @ 0x5581a1b2c3d0] Too many packets buffered for output stream 0:1.',
      '[aac @ 0x5581a1b2c4e0] Qavg: 103.618',
      '[aac @ 0x5581a1b2c4e0] 2 frames left in the queue on closing',
      'Conversion failed!',
    ].join('\n'),
  ),
  '[mp4] Too many packets buffered for output stream 0:1.',
  'encoder wrap-up lines are not part of the fallback',
);

// 较新的 ffmpeg 会在每个失败线程后再打 "Task finished with error code" / "Terminating thread"，
// 它们带 error 字样但只是包装；夹在原因行之间时不能截断，也不能被当成原因
assert.equal(
  summarizeFfmpegFailure(
    [
      '[libx264 @ 0x5581a1b2c3d0] width not divisible by 2 (853x480)',
      '[vost#0:0/libx264 @ 0x5581a1b2c4e0] [enc:libx264 @ 0x5581a1b2c5f0] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
      '[vf#0:0 @ 0x5581a1b2c610] Error sending frames to consumers: Invalid argument',
      '[vf#0:0 @ 0x5581a1b2c610] Task finished with error code: -22 (Invalid argument)',
      '[vf#0:0 @ 0x5581a1b2c610] Terminating thread with return code -22 (Invalid argument)',
      '[vost#0:0/libx264 @ 0x5581a1b2c4e0] Could not open encoder before EOF',
      '[vost#0:0/libx264 @ 0x5581a1b2c4e0] Task finished with error code: -22 (Invalid argument)',
      '[vost#0:0/libx264 @ 0x5581a1b2c4e0] Terminating thread with return code -22 (Invalid argument)',
      '[out#0/mp4 @ 0x5581a1b2c720] Nothing was written into output file, because at least one of its streams received no packets.',
      'frame=    0 fps=0.0 q=0.0 Lsize=       0kB time=N/A bitrate=N/A speed=N/A    ',
      'Conversion failed!',
    ].join('\n'),
  ),
  [
    '[libx264] width not divisible by 2 (853x480)',
    '[vost#0:0/libx264] [enc:libx264] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
    '[vf#0:0] Error sending frames to consumers: Invalid argument',
    '[vost#0:0/libx264] Could not open encoder before EOF',
  ].join('\n'),
  'newer ffmpeg task-wrapper lines and the progress line are skipped',
);

// x264 失败后会打印十几行收尾统计（真实输出，取自上面的管道写失败）：回退时不能把它们当成原因
assert.equal(
  summarizeFfmpegFailure(
    [
      '[mp4 @ 0x5581a1b2c3d0] Too many packets buffered for output stream 0:1.',
      '[libx264 @ 0x11d6052a0] frame I:1     Avg QP:16.00  size: 59837',
      '[libx264 @ 0x11d6052a0] frame P:15    Avg QP:12.27  size: 45720',
      '[libx264 @ 0x11d6052a0] mb I  I16..4: 100.0%  0.0%  0.0%',
      '[libx264 @ 0x11d6052a0] mb P  I16..4:  6.5%  0.0%  0.0%  P16..4: 11.9%  0.0%  0.0%  0.0%  0.0%    skip:81.6%',
      '[libx264 @ 0x11d6052a0] final ratefactor: 17.47',
      '[libx264 @ 0x11d6052a0] coded y,uvDC,uvAC intra: 7.3% 9.1% 8.5% inter: 7.7% 11.2% 10.0%',
      '[libx264 @ 0x11d6052a0] i16 v,h,dc,p: 91%  5%  3%  1%',
      '[libx264 @ 0x11d6052a0] kb/s:11184.61',
      'Conversion failed!',
    ].join('\n'),
  ),
  '[mp4] Too many packets buffered for output stream 0:1.',
  'x264 statistics are status chatter, not the reason',
);

// 原因行常常只是 OS 的 strerror 文案，或是 `av_xxx(): <strerror>`（strerror 的文案不一定在词表里）。
// 前面垫几行中性信息：若原因没被识别，回退会连同这些信息行一起展示，结果就不会只剩原因本身
for (const cause of [
  'av_interleaved_write_frame(): Resource temporarily unavailable',
  'av_interleaved_write_frame(): Broken pipe',
  'pipe:1: Broken pipe',
  '/v/out.mp4: Permission denied',
  '/v/out.mp4: No space left on device',
  '/v/out.mp4: Read-only file system',
  '/v/out.mp4: Is a directory',
  '/v/out.mp4/clip.mp4: Not a directory',
  '/v/out.mp4: Input/output error',
  '/v/in.mp4: Operation not permitted',
  '/v/out.mp4: File exists',
  '/v/in.mp4: Too many open files',
  '/v/out.mp4: Disk quota exceeded',
  '/v/in.mp4: Bad file descriptor',
  'tcp://host:1935: Connection refused',
  'tcp://host:1935: Connection reset by peer',
  'tcp://host:1935: Connection timed out',
]) {
  assert.equal(
    summarizeFfmpegFailure(
      [
        '[mpegts @ 0x5581a1b2c3d0] muxer info 1',
        '[mpegts @ 0x5581a1b2c3d0] muxer info 2',
        '[mpegts @ 0x5581a1b2c3d0] muxer info 3',
        cause,
        'Conversion failed!',
      ].join('\n'),
    ),
    cause,
    `${cause} is recognised as the reason`,
  );
}

// 原因之后跟着几行中性信息（不是噪声、也不是关键词）时，原因仍然可信
assert.equal(
  summarizeFfmpegFailure(
    [
      '[mp4 @ 0x5581a1b2c3d0] Could not write header (incorrect codec parameters ?): Invalid argument',
      ...Array.from(
        { length: 6 },
        (_, i) => `[mpegts @ 0x5581a1b2c4e0] muxer info ${i}`,
      ),
      'Conversion failed!',
    ].join('\n'),
  ),
  '[mp4] Could not write header (incorrect codec parameters ?): Invalid argument',
  'a handful of neutral lines after the reason do not demote it',
);

// libass 在 macOS 上反复打印的 "Error opening font" 是良性告警（随后会换别的字体），不能当成原因
assert.equal(
  summarizeFfmpegFailure(
    [
      "[Parsed_subtitles_0 @ 0x147004400] Error opening font: '/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved/PingFangUI.ttc', 0",
      "[Parsed_subtitles_0 @ 0x147004400] Error opening font: '/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved/PingFangUI.ttc', 0",
      '[mp4 @ 0x5581a1b2c3d0] Too many packets buffered for output stream 0:1.',
      'Conversion failed!',
    ].join('\n'),
  ),
  '[mp4] Too many packets buffered for output stream 0:1.',
  'benign libass font warnings are not the reason',
);

// 失败原因贴着输出末尾：最后一条关键词行之后若还有大段输出，它就与这次失败无关，
// 不能盖过没有关键词的真实原因
{
  const summary = summarizeFfmpegFailure(
    [
      '[h264 @ 0x7f8a1c004a00] error while decoding MB 12 34, bytestream -5',
      ...Array.from(
        { length: 25 },
        (_, i) => `[mpegts @ 0x7f8a1c0b0000] muxer stat line ${i}`,
      ),
      '[mp4 @ 0x7f8a1c0c0000] Too many packets buffered for output stream 0:1.',
      'Conversion failed!',
    ].join('\n'),
  );
  assert.match(summary, /Too many packets buffered for output stream 0:1\./);
  assert.doesNotMatch(summary, /decoding MB/);
}

// 连续的告警风暴只保留最后 8 行，且相同的行（地址不同也算）折叠为一行
{
  const storm = summarizeFfmpegFailure(
    [
      ...Array.from(
        { length: 30 },
        (_, i) =>
          `[h264 @ 0x7f8a1c004a00] error while decoding MB ${i} 5, bytestream -5`,
      ),
      'av_interleaved_write_frame(): No space left on device',
      'Error writing trailer of /v/out.mp4: No space left on device',
      'Conversion failed!',
    ].join('\n'),
  ).split('\n');
  assert.equal(storm.length, 8);
  assert.equal(
    storm[0],
    '[h264] error while decoding MB 24 5, bytestream -5',
    'the latest lines are kept',
  );
  assert.equal(
    storm.at(-1),
    'Error writing trailer of /v/out.mp4: No space left on device',
  );
}
assert.equal(
  summarizeFfmpegFailure(
    [
      '[h264 @ 0x5581a1b2c3d0] Invalid data found when processing input',
      '[h264 @ 0x5581a1b2c3e0] Invalid data found when processing input',
      '[h264 @ 0x5581a1b2c3f0] Invalid data found when processing input',
    ].join('\n'),
  ),
  '[h264] Invalid data found when processing input',
  'consecutive duplicates are collapsed',
);

// 超长的行被截断，界面里不会铺满
{
  const [line] = summarizeFfmpegFailure(
    `Error: ${'a'.repeat(1000)}\nConversion failed!`,
  ).split('\n');
  assert.ok(line.length <= 400, `clamped to 400 chars, got ${line.length}`);
  assert.ok(line.endsWith('…'));
}

// ── withFfmpegFailureReason：只改写 "ffmpeg exited with code N" 这一类错误 ──────

{
  const original = new Error(failures.WEBM_H264_BURN.message);
  const rewritten = withFfmpegFailureReason(
    original,
    failures.WEBM_H264_BURN.stderr,
  );
  assert.equal(
    rewritten.message,
    [
      'ffmpeg exited with code 1: ' + WEBM_MUXER_REJECTION,
      WEBM_HEADER_FAILURE,
      '[vost#0:0/libx264] Error initializing output stream:',
    ].join('\n'),
    'the #521 screenshot message now names the WebM muxer rejection',
  );
  assert.equal(
    rewritten.cause,
    original,
    'the original error is kept as cause',
  );
}
for (const fixture of [failures.UNKNOWN_ENCODER, failures.NO_STREAMS]) {
  assert.equal(fixture.message, 'ffmpeg exited with code 1: ');
  assert.match(
    withFfmpegFailureReason(new Error(fixture.message), fixture.stderr).message,
    /^ffmpeg exited with code 1: \[\S+\] \S/,
    'an empty "exited with code 1: " gets its reason',
  );
}
{
  const fixture = failures.BROKEN_PIPE_AMID_CHATTER;
  assert.equal(
    withFfmpegFailureReason(new Error(fixture.message), fixture.stderr).message,
    [
      'ffmpeg exited with code 224: av_interleaved_write_frame(): Broken pipe',
      '[out#0/mpegts] Error muxing a packet',
      '[out#0/mpegts] Error writing trailer: Broken pipe',
    ].join('\n'),
    'exit codes other than 1 are rewritten too',
  );
}
assert.equal(
  withFfmpegFailureReason(
    new Error('ffmpeg exited with code 3221225477: '),
    '[libx264 @ 0x5581a1b2c3d0] width not divisible by 2 (853x480)',
  ).message,
  'ffmpeg exited with code 3221225477: [libx264] width not divisible by 2 (853x480)',
  'large (Windows) exit codes keep their number',
);
assert.equal(
  withFfmpegFailureReason(
    new Error('ffmpeg exited with code -1073741819: '),
    'Unknown encoder x',
  ).message,
  'ffmpeg exited with code -1073741819: Unknown encoder x',
  'negative exit codes keep their number',
);

// 其它错误（被信号杀死、启动失败、取消）与没有可用原因的输出：原样返回同一个对象
for (const [error, stderr] of [
  [new Error('ffmpeg was killed with signal SIGKILL'), '[x @ 0x1] Error y'],
  [new Error('spawn ffmpeg ENOENT'), '[x @ 0x1] Error y'],
  [new Error('MERGE_CANCELLED'), '[x @ 0x1] Error y'],
  [new Error('ffmpeg exited with code 1: Conversion failed!\n'), undefined],
  [new Error('ffmpeg exited with code 1: Conversion failed!\n'), null],
  [new Error('ffmpeg exited with code 1: Conversion failed!\n'), ''],
  [
    new Error('ffmpeg exited with code 1: Conversion failed!\n'),
    'Conversion failed!\n',
  ],
] as const) {
  assert.equal(withFfmpegFailureReason(error, stderr), error);
}

console.log(
  JSON.stringify({
    checks:
      'writable-container table (webm/ogv/ogg denied, case-insensitive, others untouched), .mp4 fallback preserving case, engine-entry rejection message with remediation, directory names ignored, WebM/Ogg-to-MP4-family AAC rule, ffmpeg failure reason extracted from nine real ffmpeg 6.0 stderr captures (webm muxer, odd width, cascade, empty message, keyword-less cause, indented metadata, write failure amid libass/CoreText chatter) plus noise/CR/CRLF/trailing-distance/cap/dedupe/clamp edges and exit-code error rewriting',
  }),
);
