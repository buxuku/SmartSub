/**
 * Phase 0 PoC(任务 2.4):audioPipeline 五件套的真实样本验证。
 *
 * 覆盖:readWavInfo(WAV 头时长)/ atempoWav(链式变速)/ assembleTrack(槽位拼接:
 * 补静音+截断+总长补齐)/ encodeMp3 / replaceAudioTrack / duckMixIntoVideo / addAudioTrack。
 * 测试视频用 ffmpeg testsrc2+正弦音自动生成,配音段复用 speed-curve.mjs 的产物
 * (缺失则先跑 node scripts/dubbing/speed-curve.mjs)。
 *
 * 运行:npm run poc:dubbing-audio(产物在 node_modules/.cache/dubbing-poc,人工试听抽检)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import {
  readWavInfo,
  wavDurationMs,
  buildAtempoChain,
  atempoWav,
  assembleTrack,
  encodeMp3,
  replaceAudioTrack,
  duckMixIntoVideo,
  addAudioTrack,
} from '../../main/helpers/dubbing/audioPipeline';

// npm script 从仓库根运行;编译产物在 node_modules/.cache 下,__dirname 不可靠。
const root = process.cwd();
const pocDir = path.join(root, 'node_modules', '.cache', 'dubbing-poc');
const outDir = path.join(pocDir, 'pipeline-out');
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
  if (!cond) failed++;
}

async function main() {
  // ── 0. 素材:测试视频(30s testsrc2 + 440Hz 正弦「原音轨」)──────────────
  const videoPath = path.join(outDir, 'sample-video.mp4');
  if (!fs.existsSync(videoPath)) {
    const r = spawnSync(
      ffmpegStatic as unknown as string,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25:duration=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=30',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-y',
        videoPath,
      ],
      { stdio: 'ignore' },
    );
    if (r.status !== 0) throw new Error('failed to generate sample video');
  }

  const seg = (name: string) => {
    const p = path.join(pocDir, name);
    if (!fs.existsSync(p)) {
      throw new Error(
        `missing ${name} — 先运行 node scripts/dubbing/speed-curve.mjs`,
      );
    }
    return p;
  };
  const wavA = seg('zh-speed1.wav'); // ~7.6s
  const wavB = seg('zh-speed1.3.wav'); // ~5.8s
  const wavC = seg('en-speed1.wav'); // ~4.9s

  // ── 1. readWavInfo ────────────────────────────────────────────────────
  const infoA = readWavInfo(wavA);
  check(
    'readWavInfo 基本字段',
    infoA.sampleRate > 8000 &&
      infoA.channels === 1 &&
      infoA.bitsPerSample === 16,
    `${infoA.sampleRate}Hz/${infoA.channels}ch/${infoA.bitsPerSample}bit ${infoA.durationMs}ms`,
  );

  // ── 2. atempo 链分解 + 实际变速 ───────────────────────────────────────
  check(
    'atempo 链 1.3 → [1.3]',
    JSON.stringify(buildAtempoChain(1.3)) === '[1.3]',
  );
  check(
    'atempo 链 3.0 → [2,1.5]',
    JSON.stringify(buildAtempoChain(3)) === '[2,1.5]',
  );
  check(
    'atempo 链 0.4 → [0.5,0.8]',
    JSON.stringify(buildAtempoChain(0.4)) === '[0.5,0.8]',
  );
  const fastWav = path.join(outDir, 'atempo-1.3x.wav');
  await atempoWav(wavA, fastWav, 1.3);
  const ratio = wavDurationMs(fastWav) / infoA.durationMs;
  check(
    'atempoWav 1.3x 时长≈1/1.3',
    Math.abs(ratio - 1 / 1.3) < 0.03,
    `实际比 ${ratio.toFixed(3)}`,
  );

  // ── 3. assembleTrack:三段@1s/12s/22s,B 截断到 3s,总长补到 30s ────────
  const track = path.join(outDir, 'assembled-track.wav');
  const asm = await assembleTrack(
    [
      { wavPath: wavA, targetStartMs: 1000 },
      { wavPath: wavB, targetStartMs: 12000, maxDurationMs: 3000 },
      { wavPath: wavC, targetStartMs: 22000 },
    ],
    track,
    { totalDurationMs: 30000 },
  );
  check(
    'assembleTrack 总长=30s',
    Math.abs(asm.durationMs - 30000) <= 1,
    `${asm.durationMs}ms`,
  );
  check('assembleTrack 头一致', Math.abs(wavDurationMs(track) - 30000) <= 1);

  // ── 4. 输出形态四件套 ─────────────────────────────────────────────────
  const mp3 = path.join(outDir, 'track.mp3');
  await encodeMp3(track, mp3);
  check(
    'encodeMp3 产物存在',
    fs.existsSync(mp3) && fs.statSync(mp3).size > 10_000,
  );

  const replaced = path.join(outDir, 'out-replace.mp4');
  await replaceAudioTrack(videoPath, track, replaced);
  check(
    'replaceAudioTrack 产物存在',
    fs.existsSync(replaced) && fs.statSync(replaced).size > 50_000,
  );

  const ducked = path.join(outDir, 'out-duck.mp4');
  await duckMixIntoVideo(videoPath, track, ducked);
  check(
    'duckMixIntoVideo 产物存在',
    fs.existsSync(ducked) && fs.statSync(ducked).size > 50_000,
  );

  const multi = path.join(outDir, 'out-multitrack.mkv');
  await addAudioTrack(videoPath, track, multi);
  check(
    'addAudioTrack 产物存在',
    fs.existsSync(multi) && fs.statSync(multi).size > 50_000,
  );
  {
    // mkv 应含两条音轨:用 ffmpeg -i 的 stderr 数 Audio 流。
    const r = spawnSync(
      ffmpegStatic as unknown as string,
      ['-hide_banner', '-i', multi],
      {
        encoding: 'utf-8',
      },
    );
    const audioStreams = (r.stderr.match(/Stream #\d+:\d+.*Audio/g) ?? [])
      .length;
    check(
      'addAudioTrack 双音轨',
      audioStreams === 2,
      `${audioStreams} audio streams`,
    );
  }

  // ── 5. 取消语义:预 abort 的 signal 直接取消且不留产物 ─────────────────
  {
    const ac = new AbortController();
    ac.abort();
    const cancelledOut = path.join(outDir, 'cancelled.wav');
    let cancelled = false;
    try {
      await atempoWav(wavA, cancelledOut, 1.2, ac.signal);
    } catch (e: any) {
      cancelled =
        e?.name === 'TaskCancelledError' || /cancel/i.test(String(e?.message));
    }
    check('atempoWav 取消语义', cancelled && !fs.existsSync(cancelledOut));
  }

  console.log(
    `\n产物目录: ${path.relative(root, outDir)}(人工试听 out-*.mp4/mkv 抽检)`,
  );
  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
