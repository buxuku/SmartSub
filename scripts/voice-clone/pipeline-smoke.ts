/**
 * 质检管线端到端冒烟（纯 node，无 Electron 窗口）：
 * 用 zipvoice 随包测试音频跑 analyze → inspectRange → prepare 全链路，
 * 验证 ffmpeg filter_complex（atrim 拼接 + 增益 + 24k 重采样）真实可用；
 * 最后把 prepare 产物 ref.wav 喂给 tts-worker 做一次真实克隆合成
 * （管线产物 ↔ 克隆引擎合同的端到端验证）。
 *
 * 运行：npm run smoke:voice-clone
 */
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import {
  analyzeCloneSource,
  inspectCloneRange,
  prepareCloneReference,
  disposeCloneAnalysisSession,
} from '../../main/helpers/voiceClone/cloneAudioPipeline';
import { readWavInfo } from '../../main/helpers/dubbing/audioPipeline';
import { CLONE_TARGET_RANGES } from '../../types/voiceClone';

async function main() {
  // npm run 从仓库根执行；编译产物在 node_modules/.cache 下，__dirname 不可用作根。
  const root = process.cwd();
  const src = path.join(
    root,
    'node_modules/.cache/tts-smoke/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia/test_wavs/leijun-1.wav',
  );
  if (!fs.existsSync(src)) {
    console.error(`missing test wav: ${src}`);
    process.exit(1);
  }
  const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');
  fs.mkdirSync(outDir, { recursive: true });

  const target = CLONE_TARGET_RANGES.zipvoice;
  console.log('── analyze ──');
  const session = await analyzeCloneSource(src, 'zipvoice', {
    tempDir: outDir,
  });
  console.log(
    `duration=${session.durationMs}ms segments=${session.segments.length} envelope=${session.envelope.length} bins`,
  );
  console.log(
    `suggestion=${session.suggestion ? `${session.suggestion.startMs}–${session.suggestion.endMs} (score ${session.suggestion.score})` : 'null'}`,
  );
  if (!session.suggestion) throw new Error('expected a suggestion');

  console.log('\n── inspectRange（推荐选区）──');
  const report = inspectCloneRange(
    session,
    session.suggestion.startMs,
    session.suggestion.endMs,
    target,
  );
  console.log(JSON.stringify(report, null, 2));

  console.log('\n── prepare ──');
  const refOut = path.join(outDir, 'smoke-ref.wav');
  const { refWavPath, report: finalReport } = await prepareCloneReference(
    session,
    session.suggestion.startMs,
    session.suggestion.endMs,
    target,
    refOut,
  );
  const info = readWavInfo(refWavPath);
  console.log(
    `ref.wav: ${info.sampleRate}Hz ${info.channels}ch ${info.bitsPerSample}bit ${info.durationMs}ms`,
  );
  console.log(
    `final verdict=${finalReport.verdict} speech=${finalReport.speechMs}ms issues=[${finalReport.issues.map((i) => i.code).join(', ')}]`,
  );

  if (info.sampleRate !== 24000 || info.channels !== 1) {
    throw new Error('ref.wav format mismatch (expect 24k mono)');
  }
  if (finalReport.verdict === 'poor') {
    throw new Error('final report should not be poor for clean test wav');
  }
  disposeCloneAnalysisSession(session.id);

  // ── 管线产物 → 克隆合成（zipvoice 模型已在 PoC 缓存时才跑）──
  const modelDir = path.join(
    root,
    'node_modules/.cache/tts-smoke/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
  );
  const vocoder = path.join(
    root,
    'node_modules/.cache/tts-smoke/vocos_24khz.onnx',
  );
  if (fs.existsSync(path.join(modelDir, 'encoder.int8.onnx'))) {
    console.log('\n── clone synthesis with prepared ref ──');
    const durationMs = await synthesizeWithRef(root, modelDir, vocoder, {
      refWavPath: refWavPath,
      refText: '那还是三十六年前, 一九八七年. 我呢考上了武汉大学的计算机系.',
      text: '大家好，这是用质检管线定稿的参考音频合成的克隆语音。',
      outWavPath: path.join(outDir, 'smoke-clone.wav'),
    });
    console.log(`clone synth OK: ${durationMs}ms audio`);
  } else {
    console.log('\n(zipvoice model not cached, skip clone synthesis)');
  }
  console.log('\nsmoke OK');
}

/** 经 tts-worker 消息协议做一次克隆合成（与生产同路径）。 */
function synthesizeWithRef(
  root: string,
  modelDir: string,
  vocoder: string,
  req: {
    refWavPath: string;
    refText: string;
    text: string;
    outWavPath: string;
  },
): Promise<number> {
  const platformKey = `${process.platform}-${process.arch}`;
  const libDir = path.join(root, 'extraResources/sherpa/native', platformKey);
  const workerFile = path.join(
    root,
    'extraResources/sherpa/worker/tts-worker.js',
  );
  const model = {
    modelType: 'zipvoice',
    encoder: path.join(modelDir, 'encoder.int8.onnx'),
    decoder: path.join(modelDir, 'decoder.int8.onnx'),
    vocoder,
    tokens: path.join(modelDir, 'tokens.txt'),
    dataDir: path.join(modelDir, 'espeak-ng-data'),
    lexicon: path.join(modelDir, 'lexicon.txt'),
    numThreads: 4,
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, {
      env: {
        ...process.env,
        SHERPA_ONNX_LIB_DIR: libDir,
        PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
        LD_LIBRARY_PATH: `${libDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
      },
    });
    const finish = (fn: () => void) => {
      worker.terminate().then(fn, fn);
    };
    worker.on('message', (msg: any) => {
      if (msg.type === 'done') finish(() => resolve(msg.durationMs));
      else if (msg.type === 'error')
        finish(() => reject(new Error(msg.message)));
    });
    worker.on('error', (e) => finish(() => reject(e)));
    worker.postMessage({
      type: 'synthesize',
      id: 's1',
      model,
      text: req.text,
      sid: 0,
      speed: 1,
      outWavPath: req.outWavPath,
      generationConfig: { refWavPath: req.refWavPath, refText: req.refText },
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
