/**
 * Phase 0 验收脚本(任务 3.4):命令行跑通「srt + 视频 → 逐条合成 → 对齐 → 拼接 → 替换音轨」。
 *
 * 全链路 = tts-worker(kokoro)+ alignment(预估→预控制→实测→复测→重合成/atempo)
 *        + audioPipeline(assembleTrack→replaceAudioTrack)。
 * 即 dubbingProcessor 的命令行雏形;人工抽检输出视频的音画同步。
 *
 * 用法: npm run poc:dubbing-e2e [-- <srt路径> <视频路径>]
 * 缺省: 内置演示 SRT(含刻意超长行逼出复测/过长逻辑)+ 自动生成的 30s 测试视频。
 * 依赖: node_modules/.cache/tts-smoke/kokoro-int8-multi-lang-v1_1(kokoro 模型)。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { Worker } from 'worker_threads';
import ffmpegStatic from 'ffmpeg-static';
import { parseSubtitleCues } from '../../main/helpers/subtitleFormats';
import {
  computeSlots,
  estimateDurationMs,
  createCalibration,
  updateCalibration,
  calibratedEstimate,
  decideSpeedAction,
  recheckAfterSynthesis,
  buildAlignmentPlan,
  type FinalCue,
} from '../../main/helpers/dubbing/alignment';
import {
  wavDurationMs,
  atempoWav,
  assembleTrack,
  replaceAudioTrack,
  probeMediaDurationMs,
} from '../../main/helpers/dubbing/audioPipeline';
import type { AlignmentSpeedAction } from '../../types/dubbing';

const root = process.cwd();
const pocDir = path.join(root, 'node_modules', '.cache', 'dubbing-poc');
const outDir = path.join(pocDir, 'e2e');
const segDir = path.join(outDir, 'segments');
fs.mkdirSync(segDir, { recursive: true });

const DEMO_SRT = `1
00:00:00,500 --> 00:00:05,000
大家好,欢迎收看本期节目,今天我们请到了一位特别嘉宾。

2
00:00:05,200 --> 00:00:09,500
主持人好,观众朋友们大家好,很高兴来到这里。

3
00:00:09,800 --> 00:00:14,500
听说你们的软件把语音合成也做成了完全本地运行?

4
00:00:14,700 --> 00:00:17,200
是的,转写、翻译、校对、配音,全流程都不需要把文件上传到云端,隐私完全无忧,而且速度还很快。

5
00:00:17,900 --> 00:00:21,000
那我们马上开始今天的正式话题吧。

6
00:00:21,500 --> 00:00:24,000
SmartSub supports whisper and kokoro engines.
`;

// ── 素材准备 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const srtPath = args[0];
let videoPath = args[1];
const srtContent = srtPath ? fs.readFileSync(srtPath, 'utf-8') : DEMO_SRT;

if (!videoPath) {
  videoPath = path.join(outDir, 'sample-video.mp4');
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
}

const modelDir = path.join(
  root,
  'node_modules',
  '.cache',
  'tts-smoke',
  'kokoro-int8-multi-lang-v1_1',
);
const modelFile = ['model.int8.onnx', 'model.onnx']
  .map((f) => path.join(modelDir, f))
  .find((f) => fs.existsSync(f));
if (!modelFile) {
  console.error(`kokoro model not found under ${modelDir}`);
  process.exit(1);
}
const model = {
  modelType: 'kokoro',
  model: modelFile,
  voices: path.join(modelDir, 'voices.bin'),
  tokens: path.join(modelDir, 'tokens.txt'),
  dataDir: path.join(modelDir, 'espeak-ng-data'),
  lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
    .map((f) => path.join(modelDir, f))
    .join(','),
  ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
    .map((f) => path.join(modelDir, f))
    .join(','),
  numThreads: 2,
};

// ── TTS worker 客户端(ttsRuntime 的脚本版:runtime 依赖 electron 故不直用)──
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(
  root,
  'extraResources',
  'sherpa',
  'native',
  platformKey,
);
const worker = new Worker(
  path.join(root, 'extraResources', 'sherpa', 'worker', 'tts-worker.js'),
  {
    env: {
      ...process.env,
      SHERPA_ONNX_LIB_DIR: libDir,
      PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
      LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
    },
  },
);
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
let seq = 0;
worker.on('message', (msg: any) => {
  const key = msg.type === 'ready' ? 'load' : msg.id;
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  if (msg.type === 'error') p.reject(new Error(msg.message));
  else p.resolve(msg);
});
worker.on('error', (e) => {
  console.error('worker error:', e);
  process.exit(1);
});
function workerCall(
  type: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const id = type === 'load' ? 'load' : `s${++seq}`;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  worker.postMessage({ type, id, ...payload });
  return promise;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cues = parseSubtitleCues(srtContent, 'srt').map((c, i) => ({
    index: i,
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text.replace(/\n/g, ' '),
  }));
  console.log(`解析 ${cues.length} 条字幕;加载 kokoro…`);
  await workerCall('load', { model });

  const MEDIA_MS = (await probeMediaDurationMs(videoPath!)) || 30000;
  const slots = computeSlots(cues, { mediaDurationMs: MEDIA_MS });
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));
  let cal = createCalibration();
  const finals: FinalCue[] = [];
  const wavByIndex = new Map<number, string>();

  for (const cue of cues) {
    const slot = slotByIndex.get(cue.index)!;
    const est = calibratedEstimate(estimateDurationMs(cue.text), cal);
    const decision = decideSpeedAction(est, slot.slotMs, 'native');
    const sid = /[a-z]/i.test(cue.text[0] ?? '') ? 0 : 10;

    let wav = path.join(segDir, `cue-${cue.index}.wav`);
    let r = await workerCall('synthesize', {
      model,
      text: cue.text,
      sid,
      speed: decision.preSpeed,
      outWavPath: wav,
    });
    cal = updateCalibration(
      cal,
      est,
      Math.round(r.durationMs * decision.preSpeed),
    );

    let appliedSpeed = decision.preSpeed;
    let action: AlignmentSpeedAction =
      decision.preSpeed > 1
        ? { type: 'preSpeed', speed: decision.preSpeed }
        : { type: 'none' };
    let overlong = false;
    let resynthesized = false;

    // 复测环:重合成至多一次,之后 atempo 兜底;超红线判过长。
    for (;;) {
      const recheck = recheckAfterSynthesis(
        wavDurationMs(wav),
        slot.slotMs,
        appliedSpeed,
        { canResynthesize: true, alreadyResynthesized: resynthesized },
      );
      if (recheck.type === 'fit') break;
      if (recheck.type === 'overlong') {
        overlong = true;
        console.log(
          `  ⚠ 行${cue.index + 1} 过长:需 ${recheck.requiredFactor.toFixed(2)}x > 1.5x(进人工清单,truncate 兜底)`,
        );
        break;
      }
      if (recheck.type === 'resynthesize') {
        r = await workerCall('synthesize', {
          model,
          text: cue.text,
          sid,
          speed: recheck.speed,
          outWavPath: wav,
        });
        appliedSpeed = recheck.speed;
        action = { type: 'preSpeed', speed: recheck.speed };
        resynthesized = true;
        continue;
      }
      // atempo 兜底
      const tempo = path.join(segDir, `cue-${cue.index}-atempo.wav`);
      await atempoWav(wav, tempo, recheck.factor);
      wav = tempo;
      appliedSpeed *= recheck.factor;
      action = { type: 'atempo', factor: recheck.factor };
      break;
    }

    const finalMs = wavDurationMs(wav);
    wavByIndex.set(cue.index, wav);
    finals.push({
      index: cue.index,
      startMs: cue.startMs,
      durationMs: finalMs,
      action,
      overlong,
    });
    console.log(
      `  行${cue.index + 1} 槽位${(slot.slotMs / 1000).toFixed(1)}s 预估${(est / 1000).toFixed(1)}s → speed=${appliedSpeed.toFixed(2)} 实测${(finalMs / 1000).toFixed(1)}s ${action.type}${overlong ? ' ⚠过长' : ''}`,
    );
  }

  const plan = buildAlignmentPlan(finals, slots, { overflow: 'truncate' });
  const track = path.join(outDir, 'dub-track.wav');
  await assembleTrack(
    plan.items.map((item) => ({
      wavPath: wavByIndex.get(item.index)!,
      targetStartMs: item.targetStartMs,
      maxDurationMs: item.durationMs,
    })),
    track,
    { totalDurationMs: MEDIA_MS },
  );

  const outVideo = path.join(outDir, 'dubbed-video.mp4');
  await replaceAudioTrack(videoPath!, track, outVideo);

  const fitRate =
    plan.items.filter((i) => i.ratio <= 1.001 || i.durationMs <= i.slotMs)
      .length / plan.items.length;
  console.log(
    `\n槽位内落位率 ${(fitRate * 100).toFixed(0)}%;过长清单 [${plan.overlongIndexes.map((i) => i + 1).join(', ')}]`,
  );
  console.log(`配音轨: ${path.relative(root, track)}`);
  console.log(`输出视频: ${path.relative(root, outVideo)}(人工抽检音画同步)`);
  await worker.terminate();
}

main().catch(async (e) => {
  console.error(e);
  await worker.terminate();
  process.exit(1);
});
