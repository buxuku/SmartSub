/**
 * 统一合成引擎命令级冒烟：用 buildComposePlan 生成的计划驱动真实 ffmpeg，
 * 验证矩阵关键组合在打包 ffmpeg 上端到端可执行、输出流形态正确。
 * 运行：yarn smoke:compose（生成素材 → 逐组合执行 → 探测输出流断言）
 *
 * 覆盖组合（与 composeRunner 同形状命令）：
 *  1. hard+keep     —— 与旧纯烧录等价路径（mp4，faststart）
 *  2. hard+replace  —— 一遍出片：烧字幕 + 换配音轨
 *  3. hard+mix      —— 烧字幕 + ducking 混音（filter_complex 视频标签路径）
 *  4. soft+addTrack —— mkv：软字幕 + 双音轨（含 aac 预编码 prep 步骤）
 *  5. none+replace  —— 与旧配音导出 replaceTrack 等价路径
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import {
  buildComposePlan,
  type ComposePlan,
  type ComposePlanInput,
} from '../../main/helpers/compose/composeCommandBuilder';

const FFMPEG = ffmpegStatic as unknown as string;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-smoke-'));

let failed = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (!cond) failed++;
  console.log(
    `${cond ? '✅' : '❌'} ${label}${!cond && detail ? ` | ${detail}` : ''}`,
  );
}

function run(args: string[]) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** 计划 → ffmpeg args（与 composeRunner 的 fluent-ffmpeg 组装同形状） */
function planToArgs(plan: ComposePlan, outputPath: string): string[] {
  const args: string[] = [];
  for (const input of plan.inputs) args.push('-i', input);
  if (plan.videoFilter) args.push('-vf', plan.videoFilter);
  if (plan.complexFilter) {
    args.push('-filter_complex', plan.complexFilter.join(';'));
  }
  // fluent-ffmpeg 的 outputOptions 逐项透传；-y 已含其中
  args.push(...plan.outputOptions, outputPath);
  return args;
}

function executePlan(input: ComposePlanInput, tempTag: string) {
  const plan = buildComposePlan(input, { tempTag });
  if (plan.prep) {
    run([
      '-i',
      plan.prep.src,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
      plan.prep.dst,
    ]);
  }
  run(planToArgs(plan, input.outputPath));
  if (plan.prep) fs.rmSync(plan.prep.dst, { force: true });
}

/** 探测输出流形态（ffmpeg -i 的 stderr 流清单，不依赖 ffprobe） */
function probeStreamTypes(file: string): {
  video: number;
  audio: number;
  subtitle: number;
} {
  let stderr = '';
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    stderr = String((e as { stderr?: Buffer }).stderr ?? '');
  }
  return {
    video: (stderr.match(/Stream #.*: Video/g) ?? []).length,
    audio: (stderr.match(/Stream #.*: Audio/g) ?? []).length,
    subtitle: (stderr.match(/Stream #.*: Subtitle/g) ?? []).length,
  };
}

// ── 素材生成 ────────────────────────────────────────────────────────────────
const video = path.join(work, 'src.mp4');
const dubTrack = path.join(work, 'dub.wav');
const assFile = path.join(work, 'burn.ass');

run([
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=640x360:d=4',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=4',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  '-shortest',
  '-y',
  video,
]);
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:duration=4',
  '-ar',
  '24000',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  '-y',
  dubTrack,
]);
fs.writeFileSync(
  assFile,
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 384',
    'PlayResY: 288',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,24,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.50,0:00:03.50,Default,,0,0,0,,Compose smoke test',
  ].join('\n'),
  'utf-8',
);

const HARD = {
  mode: 'hard' as const,
  filter: `ass='${assFile.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
  encoderArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'],
  needsNv12: false,
};

// 1. hard+keep（等价旧纯烧录）
{
  const out = path.join(work, 'out-hard-keep.mp4');
  executePlan(
    {
      videoPath: video,
      outputPath: out,
      subtitle: HARD,
      audio: { mode: 'keep' },
    },
    'T1',
  );
  const s = probeStreamTypes(out);
  ok(
    fs.existsSync(out) && s.video === 1 && s.audio === 1,
    'hard+keep：烧录成功（1v1a）',
    JSON.stringify(s),
  );
}

// 2. hard+replace（一遍出片：烧字幕+换轨）
{
  const out = path.join(work, 'out-hard-replace.mp4');
  executePlan(
    {
      videoPath: video,
      outputPath: out,
      subtitle: HARD,
      audio: { mode: 'replace', trackPath: dubTrack },
    },
    'T2',
  );
  const s = probeStreamTypes(out);
  ok(
    fs.existsSync(out) && s.video === 1 && s.audio === 1,
    'hard+replace：单遍烧录+换轨成功（1v1a）',
    JSON.stringify(s),
  );
}

// 3. hard+mix（filter_complex 视频标签路径 + ducking）
{
  const out = path.join(work, 'out-hard-mix.mp4');
  executePlan(
    {
      videoPath: video,
      outputPath: out,
      subtitle: HARD,
      audio: { mode: 'mix', trackPath: dubTrack },
    },
    'T3',
  );
  const s = probeStreamTypes(out);
  ok(
    fs.existsSync(out) && s.video === 1 && s.audio === 1,
    'hard+mix：烧录+ducking 混音成功（1v1a）',
    JSON.stringify(s),
  );
}

// 4. soft+addTrack（mkv 软字幕 + 双音轨，含 prep 预编码）
{
  const out = path.join(work, 'out-soft-addtrack.mkv');
  const srt = path.join(work, 'soft.srt');
  fs.writeFileSync(
    srt,
    '1\n00:00:00,500 --> 00:00:03,500\nCompose smoke test\n',
    'utf-8',
  );
  executePlan(
    {
      videoPath: video,
      outputPath: out,
      subtitle: { mode: 'soft', subtitlePath: srt },
      audio: { mode: 'addTrack', trackPath: dubTrack },
    },
    'T4',
  );
  const s = probeStreamTypes(out);
  ok(
    fs.existsSync(out) && s.video === 1 && s.audio === 2 && s.subtitle === 1,
    'soft+addTrack：mkv 双音轨+字幕轨成功（1v2a1s）',
    JSON.stringify(s),
  );
}

// 5. none+replace（等价旧配音导出 replaceTrack）
{
  const out = path.join(work, 'out-none-replace.mp4');
  executePlan(
    {
      videoPath: video,
      outputPath: out,
      subtitle: { mode: 'none' },
      audio: { mode: 'replace', trackPath: dubTrack },
    },
    'T5',
  );
  const s = probeStreamTypes(out);
  ok(
    fs.existsSync(out) && s.video === 1 && s.audio === 1,
    'none+replace：换轨成功（1v1a）',
    JSON.stringify(s),
  );
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? '\n冒烟全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
