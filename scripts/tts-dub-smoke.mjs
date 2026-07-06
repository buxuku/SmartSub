/**
 * 「字幕配音」最小闭环冒烟(探索用,不进产品代码):
 * SRT → 逐句 TTS → 时长适配(变速钳制) → 按时间轴拼装 → 单条 wav 音轨。
 *
 * 验证 MVP 三个核心环节:
 *   1. 逐句合成:每句 cue 独立 generate(可多音色);
 *   2. 时长适配:合成音频超出 cue 窗口时,按 needed speed 重合成,钳制在 MAX_SPEED 内,
 *      仍超则允许溢出(记录溢出量)——这是未来时长策略的雏形;
 *   3. 时间轴拼装:总时长 Float32Array,按 cue.start 偏移写入采样(纯 JS,无需 ffmpeg)。
 *
 * 用法: node scripts/tts-dub-smoke.mjs [input.srt] [--engine=aishell3|kokoro]
 * 缺省使用脚本内置的演示 SRT(双角色对话,含一句刻意塞长的台词逼出变速逻辑)。
 * --engine=kokoro 用 Kokoro v1.1 int8(24kHz,中英混合),缺省 aishell3(8kHz)。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const platformKey = `${process.platform}-${process.arch}`;
process.env.SHERPA_ONNX_LIB_DIR = path.join(
  root,
  'extraResources',
  'sherpa',
  'native',
  platformKey,
);
const sherpa = require(
  path.join(root, 'extraResources', 'sherpa', 'vendor', 'sherpa-onnx.js'),
);

const engine = process.argv.includes('--engine=kokoro') ? 'kokoro' : 'aishell3';
const cacheDir = path.join(root, 'node_modules', '.cache', 'tts-smoke');
const outDir = path.join(cacheDir, 'out');
fs.mkdirSync(outDir, { recursive: true });

// ── 演示 SRT:双角色访谈,cue#4 刻意窗口紧逼出变速 ────────────────────────────
const DEMO_SRT = `1
00:00:00,500 --> 00:00:05,000
[S1] 大家好,欢迎收看本期节目,今天我们请到了一位特别嘉宾。

2
00:00:05,200 --> 00:00:09,500
[S2] 主持人好,观众朋友们大家好,很高兴来到这里。

3
00:00:09,800 --> 00:00:14,500
[S1] 听说你们的软件把语音合成也做成了完全本地运行?

4
00:00:14,700 --> 00:00:17,200
[S2] 是的,转写、翻译、校对、配音,全流程都不需要把文件上传到云端,隐私完全无忧。

5
00:00:17,600 --> 00:00:21,000
[S1] 那我们马上开始今天的正式话题吧。
`;

// ── 极简 SRT 解析(仅探索用;产品侧已有成熟解析) ─────────────────────────────
function parseSrtTime(t) {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
function parseSrt(text) {
  return text
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const timeline = lines.find((l) => l.includes('-->'));
      if (!timeline) return null;
      const [start, end] = timeline.split('-->').map(parseSrtTime);
      const textLines = lines.slice(lines.indexOf(timeline) + 1);
      let text = textLines.join(' ').trim();
      // 角色标签约定:[S1]/[S2] 前缀(对应探索文档「角色标签存哪」一节)
      let speaker = null;
      const sp = text.match(/^\[(S\d+)\]\s*/);
      if (sp) {
        speaker = sp[1];
        text = text.slice(sp[0].length);
      }
      return { start, end, text, speaker };
    })
    .filter(Boolean);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const srtPath = process.argv
  .slice(2)
  .find((a) => !a.startsWith('--'));
const srt = srtPath ? fs.readFileSync(srtPath, 'utf-8') : DEMO_SRT;
const cues = parseSrt(srt);

// 角色→音色映射(未来是 UI 面板;此处写死两个听感差异大的音色)
// kokoro v1.1 音色布局:0-2 英文,3-57 中文女声(zf_*),58-102 中文男声(zm_*)
const VOICE_MAP =
  engine === 'kokoro'
    ? { S1: 10, S2: 80, default: 18 }
    : { S1: 0, S2: 66, default: 99 };
const MAX_SPEED = 1.5; // 时长适配的变速钳制上限(超过则允许溢出)

function buildTtsConfig() {
  if (engine === 'kokoro') {
    const dir = path.join(cacheDir, 'kokoro-int8-multi-lang-v1_1');
    return {
      model: {
        kokoro: {
          model: path.join(dir, 'model.int8.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
            .map((f) => path.join(dir, f))
            .join(','),
        },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
        .map((f) => path.join(dir, f))
        .join(','),
      maxNumSentences: 1,
    };
  }
  const dir = path.join(cacheDir, 'vits-icefall-zh-aishell3');
  return {
    model: {
      vits: {
        model: path.join(dir, 'model.onnx'),
        lexicon: path.join(dir, 'lexicon.txt'),
        tokens: path.join(dir, 'tokens.txt'),
      },
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    ruleFsts: ['phone.fst', 'date.fst', 'number.fst']
      .map((f) => path.join(dir, f))
      .join(','),
    maxNumSentences: 1,
  };
}

console.log(`[1/3] 加载 TTS 模型(engine=${engine})…`);
const tts = new sherpa.OfflineTts(buildTtsConfig());
const sr = tts.sampleRate;
console.log(`  numSpeakers=${tts.numSpeakers} sampleRate=${sr}`);

console.log(`[2/3] 逐句合成 + 时长适配(${cues.length} 句)…`);
const rendered = [];
for (const [i, cue] of cues.entries()) {
  const window = cue.end - cue.start;
  const sid = VOICE_MAP[cue.speaker] ?? VOICE_MAP.default;
  let speed = 1.0;
  let audio = tts.generate({ text: cue.text, sid, speed });
  let dur = audio.samples.length / sr;
  let note = '';
  if (dur > window) {
    // 需要的变速比,钳制到 MAX_SPEED;VITS 的 speed 与产物时长近似成反比
    const needed = Math.min(dur / window, MAX_SPEED);
    speed = Math.round(needed * 100) / 100;
    audio = tts.generate({ text: cue.text, sid, speed });
    dur = audio.samples.length / sr;
    note =
      dur > window
        ? ` ⚠ 变速${speed}x后仍溢出 ${(dur - window).toFixed(2)}s(允许侵入间隙)`
        : ` ✓ 变速${speed}x 塞入窗口`;
  }
  rendered.push({ cue, audio, dur });
  console.log(
    `  cue#${i + 1} [${cue.speaker ?? '-'}→sid${sid}] 窗口${window.toFixed(2)}s / 产物${dur.toFixed(2)}s${note}`,
  );
}

console.log(`[3/3] 按时间轴拼装整轨…`);
const totalSec =
  Math.max(...rendered.map((r) => r.cue.start + r.dur), cues.at(-1).end) + 0.5;
const track = new Float32Array(Math.ceil(totalSec * sr));
for (const r of rendered) {
  const offset = Math.round(r.cue.start * sr);
  // 叠加写入(而非覆盖):溢出侵入下一句时两段声音交叠,暴露真实听感
  for (let i = 0; i < r.audio.samples.length && offset + i < track.length; i++) {
    track[offset + i] += r.audio.samples[i];
  }
}
// 防叠加削波
for (let i = 0; i < track.length; i++) {
  if (track[i] > 1) track[i] = 1;
  else if (track[i] < -1) track[i] = -1;
}

const outFile = path.join(outDir, `dubbed-track-${engine}.wav`);
sherpa.writeWave(outFile, { samples: track, sampleRate: sr });
console.log(
  `done. 整轨 ${totalSec.toFixed(2)}s → ${path.relative(root, outFile)}`,
);
console.log(`试听: afplay "${outFile}"`);
