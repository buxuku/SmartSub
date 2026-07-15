/**
 * composeCommandBuilder 单元验证（纯函数，无 electron/ffmpeg 依赖）。
 * 运行：yarn test:compose
 *
 * 等价性契约（与收敛前实现逐参数一致）：
 * - hard+keep / soft+keep ≡ 旧 subtitleMerger 的 hardcode / softmux 分支
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

// ── 等价性：hard+keep ≡ 旧 subtitleMerger hardcode 分支 ─────────────────────

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
    'hard+keep(mp4): 与旧 hardcode 分支逐参数一致（含 faststart）',
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

// ── 等价性：soft+keep ≡ 旧 subtitleMerger softmux 分支 ──────────────────────

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
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-c:s',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+keep: 与旧 softmux 分支逐参数一致',
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
      '2',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-c:s',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+replace: 视频流复制 + 换轨 + 字幕轨',
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
      '0',
      '-map',
      '1:a',
      '-map',
      '2',
      '-c',
      'copy',
      '-c:s',
      'srt',
      '-disposition:s:0',
      'default',
      '-y',
    ],
    'soft+addTrack: 全流拷贝 + 附加轨 + 字幕轨',
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
  true,
  'soft 需要 mkv',
);
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

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项断言失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
