/**
 * TTS 最小冒烟脚本(探索用,不进产品代码):
 * 直接复用应用随包内置的 sherpa-onnx 原生库(extraResources/sherpa/native/<platform>)
 * 与 vendor JS 封装(extraResources/sherpa/vendor),验证「零新增原生依赖」的本地 TTS 路径:
 *   1. OfflineTts 能否在内置库上创建(TTS 已编译进原生库的运行时证明);
 *   2. 中文多说话人模型(vits-icefall-zh-aishell3,174 音色)逐句合成;
 *   3. 多音色(sid)= 未来「角色→音色」映射的最小演示;
 *   4. speed 参数 = 未来「字幕 cue 时长适配」的抓手;
 *   5. writeWave 落盘 + RTF(实时率)统计。
 *
 * 用法:
 *   node scripts/tts-smoke.mjs
 * 模型(需先解压到 node_modules/.cache/tts-smoke/vits-icefall-zh-aishell3):
 *   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 与 sherpaFunasrRuntime.ts 相同的注入方式:vendor/addon.js 从该 env dlopen 原生库
const platformKey = `${process.platform}-${process.arch}`;
const libDir = path.join(root, 'extraResources', 'sherpa', 'native', platformKey);
if (!fs.existsSync(path.join(libDir, 'sherpa-onnx.node'))) {
  console.error(`native lib not found for ${platformKey}: ${libDir}`);
  process.exit(1);
}
process.env.SHERPA_ONNX_LIB_DIR = libDir;

const sherpa = require(
  path.join(root, 'extraResources', 'sherpa', 'vendor', 'sherpa-onnx.js'),
);

const modelDir = path.join(
  root,
  'node_modules',
  '.cache',
  'tts-smoke',
  'vits-icefall-zh-aishell3',
);
if (!fs.existsSync(path.join(modelDir, 'model.onnx'))) {
  console.error(`model not found: ${modelDir}(见文件头注释的下载地址)`);
  process.exit(1);
}

const outDir = path.join(root, 'node_modules', '.cache', 'tts-smoke', 'out');
fs.mkdirSync(outDir, { recursive: true });

console.log(`[1/3] createOfflineTts(lib=${platformKey}, model=aishell3)…`);
const t0 = Date.now();
const tts = new sherpa.OfflineTts({
  model: {
    vits: {
      model: path.join(modelDir, 'model.onnx'),
      lexicon: path.join(modelDir, 'lexicon.txt'),
      tokens: path.join(modelDir, 'tokens.txt'),
    },
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
  // 数字/日期等文本归一化规则(aishell3 附带)
  ruleFsts: ['phone.fst', 'date.fst', 'number.fst']
    .map((f) => path.join(modelDir, f))
    .join(','),
  maxNumSentences: 1,
});
console.log(
  `  loaded in ${Date.now() - t0}ms · numSpeakers=${tts.numSpeakers} · sampleRate=${tts.sampleRate}`,
);

// 模拟字幕逐句合成:不同 cue 用不同角色音色(sid),对照未来「角色→音色」映射
const cues = [
  { text: '大家好,欢迎收看本期节目。', sid: 0, speed: 1.0 },
  { text: '今天我们来聊一聊本地语音合成。', sid: 66, speed: 1.0 },
  { text: '所有处理都在本机完成,无需上传任何文件。', sid: 103, speed: 1.2 },
];

console.log(`[2/3] 逐句合成 ${cues.length} 句(多音色 + 变速)…`);
let totalAudioSec = 0;
let totalGenMs = 0;
for (const [i, cue] of cues.entries()) {
  const start = Date.now();
  const audio = tts.generate({ text: cue.text, sid: cue.sid, speed: cue.speed });
  const genMs = Date.now() - start;
  const durSec = audio.samples.length / audio.sampleRate;
  totalAudioSec += durSec;
  totalGenMs += genMs;
  const file = path.join(outDir, `cue-${i + 1}-sid${cue.sid}.wav`);
  sherpa.writeWave(file, {
    samples: audio.samples,
    sampleRate: audio.sampleRate,
  });
  console.log(
    `  cue#${i + 1} sid=${String(cue.sid).padStart(3)} speed=${cue.speed} → ${durSec.toFixed(2)}s 音频 / 合成耗时 ${genMs}ms → ${path.relative(root, file)}`,
  );
}

console.log(
  `[3/3] 合计音频 ${totalAudioSec.toFixed(2)}s,合成 ${totalGenMs}ms,RTF=${(
    totalGenMs / 1000 / totalAudioSec
  ).toFixed(3)}(<1 即快于实时)`,
);
console.log('done. 试听: open ' + path.relative(root, outDir));
