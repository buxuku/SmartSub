/**
 * composeCommandBuilder 单元验证（纯函数，无 electron/ffmpeg 依赖）。
 * 运行：yarn test:compose
 *
 * 等价性契约（与收敛前实现逐参数一致）：
 * - hard+keep 显式保留视频/全部音轨；soft 保留原字幕并注入新的默认轨
 * - none+replace/mix/addTrack ≡ 旧 audioPipeline 的
 *   replaceAudioTrack / duckMixIntoVideo / addAudioTrack
 */

import {
  buildComposePlan,
  composePlanRequiresMkv,
  type ComposePlanInput,
} from '../../main/helpers/compose/composeCommandBuilder';

let failed = 0;

function assertDeepEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n   expected=${b}\n   actual  =${a}`}`,
  );
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : ` | expected=${expected} actual=${actual}`}`,
  );
}

function assertThrows(fn: () => unknown, label: string) {
  try {
    fn();
    failed++;
    console.log(`❌ ${label} | expected to throw`);
  } catch {
    console.log(`✅ ${label}`);
  }
}

/** 抛错且消息匹配：区分「新防护抛出的错」与「别处的无关错误」。 */
function assertThrowsMatching(
  fn: () => unknown,
  pattern: RegExp,
  label: string,
) {
  try {
    fn();
    failed++;
    console.log(`❌ ${label} | expected to throw`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ok = pattern.test(message);
    if (!ok) failed++;
    console.log(
      `${ok ? '✅' : '❌'} ${label}${ok ? '' : ` | message=${message}`}`,
    );
  }
}

const VIDEO = '/media/movie.mp4';
const TRACK = '/media/dub.wav';
const SUB = '/media/movie.srt';

const HARD = {
  mode: 'hard' as const,
  filter: "ass='/tmp/burn.ass'",
  encoderArgs: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
  needsNv12: false,
};

const HW_HARD = {
  ...HARD,
  encoderArgs: ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  needsNv12: true,
};

const DUCK_FILTERS = [
  '[1:a]asplit=2[sc][dub]',
  '[0:a][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bg]',
  '[bg][dub]amix=inputs=2:duration=first:normalize=0[mix]',
];

for (const subtitle of [
  HARD,
  { mode: 'none' as const },
  { mode: 'soft' as const, subtitlePath: SUB },
]) {
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/silent.mkv',
    subtitle,
    audio: { mode: 'mix', trackPath: TRACK },
    hasOriginalAudio: false,
  });
  assertEqual(
    plan.complexFilter,
    undefined,
    `${subtitle.mode}+mix silent source: no missing audio filter input`,
  );
  assertEqual(
    plan.outputOptions.includes('1:a'),
    true,
    `${subtitle.mode}+mix silent source: selected voice track mapped`,
  );
}

// ── hard+keep：显式音视频映射，防止额外选择原软字幕 ──────────────────────

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: HARD,
    audio: { mode: 'keep' },
  });
  assertDeepEqual(plan.inputs, [VIDEO], 'hard+keep: 单视频输入');
  assertEqual(plan.videoFilter, "ass='/tmp/burn.ass'", 'hard+keep: 字幕滤镜');
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
    ],
    'hard+keep(mp4): 保留全部音轨，不额外封装软字幕（含 faststart）',
  );
  assertEqual(plan.prep, undefined, 'hard+keep: 无准备步骤');
}

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mkv',
    subtitle: HARD,
    audio: { mode: 'keep' },
  });
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'copy',
      '-y',
    ],
    'hard+keep(mkv): 非 MP4 系无 faststart',
  );
}

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: HW_HARD,
    audio: { mode: 'keep' },
  });
  assertEqual(
    plan.videoFilter,
    "ass='/tmp/burn.ass',format=nv12",
    'hard(硬件)+keep: 滤镜链追加 format=nv12',
  );
}

// ── 软字幕显式映射 ──────────────────────────────────────────────────────

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mkv',
    subtitle: { mode: 'soft', subtitlePath: SUB },
    audio: { mode: 'keep' },
  });
  assertDeepEqual(plan.inputs, [VIDEO, SUB], 'soft+keep: 视频+字幕两输入');
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '1:s:0',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-c',
      'copy',
      '-c:s:0',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+keep: 新默认字幕 + 原字幕/附件保留，排除数据流',
  );
  assertEqual(plan.videoFilter, undefined, 'soft+keep: 无视频滤镜');
}

// ── 等价性：none+audio ≡ 旧 audioPipeline 三形态 ────────────────────────────

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: { mode: 'none' },
    audio: { mode: 'replace', trackPath: TRACK },
  });
  assertDeepEqual(plan.inputs, [VIDEO, TRACK], 'none+replace: 视频+音轨输入');
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '0:s?',
      '-c:v',
      'copy',
      '-c:s',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
    ],
    'none+replace: 与旧 replaceAudioTrack 逐参数一致',
  );
}

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: { mode: 'none' },
    audio: { mode: 'mix', trackPath: TRACK },
  });
  assertDeepEqual(
    plan.complexFilter,
    DUCK_FILTERS,
    'none+mix: ducking 滤镜与旧 duckMixIntoVideo 一致（缺省 ratio=8）',
  );
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '[mix]',
      '-map',
      '0:s?',
      '-c:v',
      'copy',
      '-c:s',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
    ],
    'none+mix: 输出选项与旧实现一致',
  );
}

{
  const plan = buildComposePlan(
    {
      videoPath: VIDEO,
      outputPath: '/media/out.mkv',
      subtitle: { mode: 'none' },
      audio: { mode: 'addTrack', trackPath: TRACK },
    },
    { tempTag: 'T' },
  );
  assertDeepEqual(
    plan.prep,
    { kind: 'encodeAac', src: TRACK, dst: '/media/.dub-track-T.m4a' },
    'none+addTrack: 先预编 aac 临时文件（两步形制保留）',
  );
  assertDeepEqual(
    plan.inputs,
    [VIDEO, '/media/.dub-track-T.m4a'],
    'none+addTrack: 主命令输入为视频+预编 aac',
  );
  assertDeepEqual(
    plan.outputOptions,
    ['-map', '0', '-map', '1:a', '-c', 'copy', '-y'],
    'none+addTrack: 与旧 addAudioTrack 逐参数一致',
  );
}

// ── 新组合：hard × 音轨 ─────────────────────────────────────────────────────

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: HARD,
    audio: { mode: 'replace', trackPath: TRACK },
  });
  assertDeepEqual(plan.inputs, [VIDEO, TRACK], 'hard+replace: 两输入');
  assertEqual(
    plan.videoFilter,
    "ass='/tmp/burn.ass'",
    'hard+replace: -vf 滤镜',
  );
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-y',
    ],
    'hard+replace: 单遍完成烧录与换轨',
  );
}

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: HW_HARD,
    audio: { mode: 'mix', trackPath: TRACK, duckRatio: 12 },
  });
  assertEqual(plan.videoFilter, undefined, 'hard+mix: 无 -vf（并入 complex）');
  assertDeepEqual(
    plan.complexFilter,
    [
      "[0:v]ass='/tmp/burn.ass',format=nv12[vout]",
      '[1:a]asplit=2[sc][dub]',
      '[0:a][sc]sidechaincompress=threshold=0.03:ratio=12:attack=20:release=300[bg]',
      '[bg][dub]amix=inputs=2:duration=first:normalize=0[mix]',
    ],
    'hard+mix: 视频滤镜并入 complex 图 + 自定义 duckRatio',
  );
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '[vout]',
      '-map',
      '[mix]',
      '-c:v',
      'h264_nvenc',
      '-rc',
      'vbr',
      '-cq',
      '19',
      '-b:v',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-y',
    ],
    'hard+mix: map 标签输出 + 硬件编码参数',
  );
}

{
  const plan = buildComposePlan(
    {
      videoPath: VIDEO,
      outputPath: '/media/out.mp4',
      subtitle: HARD,
      audio: { mode: 'addTrack', trackPath: TRACK },
    },
    { tempTag: 'T' },
  );
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
    ],
    'hard+addTrack: 原音轨保留 + 预编 aac 附加轨（音频统一 copy）',
  );
}

// ── 新组合：soft × 音轨 ─────────────────────────────────────────────────────

{
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mkv',
    subtitle: { mode: 'soft', subtitlePath: SUB },
    audio: { mode: 'replace', trackPath: TRACK },
  });
  assertDeepEqual(plan.inputs, [VIDEO, TRACK, SUB], 'soft+replace: 三输入');
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:s:0',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-c',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-c:s:0',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+replace: 视频流复制 + 换轨 + 新旧字幕轨',
  );
}

{
  const plan = buildComposePlan(
    {
      videoPath: VIDEO,
      outputPath: '/media/out.mkv',
      subtitle: { mode: 'soft', subtitlePath: SUB },
      audio: { mode: 'addTrack', trackPath: TRACK },
    },
    { tempTag: 'T' },
  );
  assertDeepEqual(
    plan.inputs,
    [VIDEO, '/media/.dub-track-T.m4a', SUB],
    'soft+addTrack: 预编轨 + 字幕输入顺序',
  );
  assertDeepEqual(
    plan.outputOptions,
    [
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '1:a',
      '-map',
      '2:s:0',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-c',
      'copy',
      '-c:s:0',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+addTrack: 保留原音轨/字幕/附件 + 附加轨 + 新字幕轨',
  );
}

// ── 约束与非法组合 ──────────────────────────────────────────────────────────

assertThrows(
  () =>
    buildComposePlan({
      videoPath: VIDEO,
      outputPath: '/media/out.mp4',
      subtitle: { mode: 'none' },
      audio: { mode: 'keep' },
    }),
  'none+keep: 无处理内容，拒绝',
);

assertEqual(
  composePlanRequiresMkv({
    subtitle: { mode: 'soft' },
    audio: { mode: 'keep' },
  }),
  false,
  'soft 支持 MKV 或 MP4',
);
for (const mode of ['keep', 'replace', 'mix'] as const) {
  const plan = buildComposePlan({
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: { mode: 'soft', subtitlePath: SUB },
    audio: mode === 'keep' ? { mode } : { mode, trackPath: TRACK },
  });
  assertEqual(
    plan.outputOptions[plan.outputOptions.indexOf('-c:s') + 1],
    'mov_text',
    `MP4 soft+${mode}: mov_text subtitle codec`,
  );
  assertEqual(
    plan.outputOptions.includes('libx264'),
    false,
    `MP4 soft+${mode}: no video encoding`,
  );
  assertEqual(
    plan.outputOptions.includes('+faststart'),
    true,
    `MP4 soft+${mode}: faststart`,
  );
}
assertThrows(
  () =>
    buildComposePlan({
      videoPath: VIDEO,
      outputPath: '/media/out.avi',
      subtitle: { mode: 'soft', subtitlePath: SUB },
      audio: { mode: 'keep' },
    }),
  'soft rejects unsupported containers',
);
{
  const streams = [
    {
      subIndex: 0,
      codec: 'hdmv_pgs_subtitle',
      isText: false,
      isDefault: true,
      isForced: true,
    },
  ];
  const input: ComposePlanInput = {
    videoPath: VIDEO,
    outputPath: '/media/out.mp4',
    subtitle: { mode: 'soft', subtitlePath: SUB },
    audio: { mode: 'keep' },
    embeddedSubtitles: streams,
  };
  assertThrows(
    () => buildComposePlan(input),
    'MP4 rejects bitmap subtitles with MKV guidance',
  );
  const plan = buildComposePlan({ ...input, outputPath: '/media/out.mkv' });
  assertEqual(
    plan.outputOptions[plan.outputOptions.indexOf('-c:s:0') + 1],
    'srt',
    'MKV encodes only the injected track',
  );
  assertEqual(
    plan.outputOptions.includes('-c:s'),
    false,
    'MKV existing bitmap/text tracks are copied',
  );
  assertEqual(
    plan.outputOptions[plan.outputOptions.indexOf('-disposition:s:1') + 1],
    '-default',
    'original default flag removed without removing forced',
  );
}
assertEqual(
  composePlanRequiresMkv({
    subtitle: { mode: 'hard' },
    audio: { mode: 'addTrack' },
  }),
  true,
  'addTrack 需要 mkv',
);
assertEqual(
  composePlanRequiresMkv({
    subtitle: { mode: 'hard' },
    audio: { mode: 'replace' },
  }),
  false,
  'hard+replace 不强制 mkv',
);

// ── #521：WebM/Ogg 容器写不下合成引擎产出的 H.264/AAC，构建期即拒绝 ─────────

for (const outputPath of [
  '/media/out.webm',
  '/media/OUT.WEBM',
  '/media/out.ogv',
  '/media/out.ogg',
]) {
  for (const [label, subtitle, audio] of [
    ['hard+keep', HARD, { mode: 'keep' }],
    ['hard+replace', HARD, { mode: 'replace', trackPath: TRACK }],
    ['hard+mix', HARD, { mode: 'mix', trackPath: TRACK }],
    ['hard+addTrack', HARD, { mode: 'addTrack', trackPath: TRACK }],
    ['none+replace', { mode: 'none' }, { mode: 'replace', trackPath: TRACK }],
    ['none+mix', { mode: 'none' }, { mode: 'mix', trackPath: TRACK }],
    ['none+addTrack', { mode: 'none' }, { mode: 'addTrack', trackPath: TRACK }],
  ] as const) {
    assertThrowsMatching(
      () => buildComposePlan({ videoPath: VIDEO, outputPath, subtitle, audio }),
      /WebM\/Ogg/,
      `${label}: ${outputPath} 被拒绝（WebM/Ogg 写不下 H.264/AAC）`,
    );
  }
}
assertThrows(
  () =>
    buildComposePlan({
      videoPath: VIDEO,
      outputPath: '/media/out.webm',
      subtitle: { mode: 'soft', subtitlePath: SUB },
      audio: { mode: 'keep' },
    }),
  'soft: .webm 仍被软字幕容器规则拒绝',
);

// ── #521：hard+keep 的音频规则——WebM/Ogg 源写 MP4 系输出才转 AAC ───────────

function hardKeepAudioArgs(
  videoPath: string,
  outputPath: string,
  subtitle: typeof HARD = HARD,
): string[] {
  const { outputOptions } = buildComposePlan({
    videoPath,
    outputPath,
    subtitle,
    audio: { mode: 'keep' },
  });
  const index = outputOptions.indexOf('-c:a');
  return outputOptions.slice(
    index,
    outputOptions[index + 1] === 'aac' ? index + 4 : index + 2,
  );
}

for (const [source, output] of [
  ['/media/clip.webm', '/media/clip_subtitled.mp4'],
  ['/media/clip.WEBM', '/media/clip_subtitled.MP4'],
  ['/media/clip.webm', '/media/clip_subtitled.mov'],
  ['/media/clip.webm', '/media/clip_subtitled.m4v'],
  ['/media/clip.ogv', '/media/clip_subtitled.mp4'],
  ['/media/clip.ogg', '/media/clip_subtitled.mp4'],
]) {
  assertDeepEqual(
    hardKeepAudioArgs(source, output),
    ['-c:a', 'aac', '-b:a', '192k'],
    `hard+keep ${source.split('.').pop()}→${output.split('.').pop()}: Opus/Vorbis 转 AAC 192k`,
  );
}
assertDeepEqual(
  hardKeepAudioArgs('/media/clip.webm', '/media/clip_subtitled.mp4', HW_HARD),
  ['-c:a', 'aac', '-b:a', '192k'],
  'hard(硬件)+keep webm→mp4: AAC 规则与编码器无关',
);
for (const [source, output] of [
  // 用户手动选 .mkv：Matroska 接受 Opus/Vorbis，保持直拷
  ['/media/clip.webm', '/media/clip_subtitled.mkv'],
  ['/media/clip.mp4', '/media/clip_subtitled.mp4'],
  ['/media/clip.mkv', '/media/clip_subtitled.mp4'],
  ['/media/clip.mov', '/media/clip_subtitled.mp4'],
  ['/media/clip.avi', '/media/clip_subtitled.avi'],
]) {
  assertDeepEqual(
    hardKeepAudioArgs(source, output),
    ['-c:a', 'copy'],
    `hard+keep ${source.split('.').pop()}→${output.split('.').pop()}: 保持 -c:a copy（既有行为）`,
  );
}
assertDeepEqual(
  buildComposePlan({
    videoPath: '/media/clip.webm',
    outputPath: '/media/clip_subtitled.mp4',
    subtitle: HARD,
    audio: { mode: 'keep' },
  }).outputOptions,
  [
    '-map',
    '0:v',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-y',
  ],
  'hard+keep webm→mp4: 完整参数（libx264 + AAC + faststart）',
);
assertEqual(
  buildComposePlan({
    videoPath: '/media/clip.webm',
    outputPath: '/media/clip_subtitled.mkv',
    subtitle: HARD,
    audio: { mode: 'keep' },
  }).outputOptions.includes('-movflags'),
  false,
  'hard+keep webm→mkv: 非 MP4 系无 faststart',
);

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项断言失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
