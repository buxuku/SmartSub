/**
 * Kokoro v1.1 多语种 TTS 冒烟(探索用,不进产品代码):
 * 相比 aishell3 冒烟(tts-smoke.mjs)重点验证三件事:
 *   1. 24kHz 音质(aishell3 仅 8kHz 电话音质);
 *   2. 中英混合(code-switching)单句直出;
 *   3. 82M 模型 int8 量化在 CPU 上的 RTF(逐句配音的性能上限)。
 *
 * 模型:kokoro-int8-multi-lang-v1_1(int8 量化,~147MB 包)
 *   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2
 * 音色布局(共 103):sid 0-2 英文(af_maple/af_sol/bf_vale),3-57 中文女声(zf_*),58-102 中文男声(zm_*)。
 *
 * 用法: node scripts/tts-kokoro-smoke.mjs
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
  console.error(`model not found under ${modelDir}(见文件头注释的下载地址)`);
  process.exit(1);
}

const outDir = path.join(root, 'node_modules', '.cache', 'tts-smoke', 'out');
fs.mkdirSync(outDir, { recursive: true });

console.log(`[1/3] createOfflineTts(kokoro v1.1 int8)…`);
const t0 = Date.now();
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: {
      model: modelFile,
      voices: path.join(modelDir, 'voices.bin'),
      tokens: path.join(modelDir, 'tokens.txt'),
      dataDir: path.join(modelDir, 'espeak-ng-data'),
      // 中英双词典:中文走 lexicon-zh,英文走 lexicon-us-en,未命中回落 espeak-ng
      lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt']
        .map((f) => path.join(modelDir, f))
        .join(','),
    },
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
  // 中文数字/日期/电话归一化规则(模型包附带)
  ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst']
    .map((f) => path.join(modelDir, f))
    .join(','),
  maxNumSentences: 1,
});
console.log(
  `  loaded in ${Date.now() - t0}ms · numSpeakers=${tts.numSpeakers} · sampleRate=${tts.sampleRate}`,
);

const cues = [
  { label: '中文女声', text: '大家好,欢迎收看本期节目,今天聊聊本地语音合成。', sid: 10, speed: 1.0 },
  { label: '中文男声', text: '所有处理都在本机完成,不需要上传任何文件。', sid: 80, speed: 1.0 },
  {
    label: '中英混合',
    text: '妙幕支持 whisper 和 faster-whisper 引擎,也可以用 Kokoro 做 TTS 配音。',
    sid: 18,
    speed: 1.0,
  },
  { label: '变速1.3x', text: '这一句用一点三倍速合成,验证时长适配的抓手。', sid: 10, speed: 1.3 },
  { label: '纯英文', text: 'SmartSub keeps every frame beautifully expressive.', sid: 0, speed: 1.0 },
];

console.log(`[2/3] 合成 ${cues.length} 句(女/男/中英混/变速/纯英)…`);
let totalAudioSec = 0;
let totalGenMs = 0;
for (const [i, cue] of cues.entries()) {
  const start = Date.now();
  const audio = tts.generate({ text: cue.text, sid: cue.sid, speed: cue.speed });
  const genMs = Date.now() - start;
  const durSec = audio.samples.length / audio.sampleRate;
  totalAudioSec += durSec;
  totalGenMs += genMs;
  const file = path.join(outDir, `kokoro-${i + 1}-${cue.label}-sid${cue.sid}.wav`);
  sherpa.writeWave(file, {
    samples: audio.samples,
    sampleRate: audio.sampleRate,
  });
  console.log(
    `  #${i + 1} ${cue.label}(sid=${cue.sid}, speed=${cue.speed}) → ${durSec.toFixed(2)}s / 合成 ${genMs}ms → ${path.basename(file)}`,
  );
}

console.log(
  `[3/3] 合计音频 ${totalAudioSec.toFixed(2)}s,合成 ${totalGenMs}ms,RTF=${(
    totalGenMs / 1000 / totalAudioSec
  ).toFixed(3)}(<1 即快于实时)`,
);
console.log('done. 试听: open ' + path.relative(root, outDir));
