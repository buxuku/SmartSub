import assert from 'assert';
import { buildAudioExtractArgs } from '../../main/helpers/toolbox/audioExtractor';

function runTests() {
  console.log('Running audioExtractor tests...');

  // 1. 测试 MP3 参数构建
  const mp3Args = buildAudioExtractArgs(
    {
      videoPath: '/test/video.mp4',
      format: 'mp3',
      bitrate: '320k',
    },
    '/test/out.mp3',
  );
  assert.ok(mp3Args.includes('-c:a'));
  assert.strictEqual(mp3Args[mp3Args.indexOf('-c:a') + 1], 'libmp3lame');
  assert.strictEqual(mp3Args[mp3Args.indexOf('-b:a') + 1], '320k');

  // 2. 测试 WAV ASR 预设 (16kHz 单声道)
  const wavAsrArgs = buildAudioExtractArgs(
    {
      videoPath: '/test/video.mp4',
      format: 'wav',
      wavPreset: 'asr_16k_mono',
    },
    '/test/out.wav',
  );
  assert.ok(wavAsrArgs.includes('-ar'));
  assert.strictEqual(wavAsrArgs[wavAsrArgs.indexOf('-ar') + 1], '16000');
  assert.ok(wavAsrArgs.includes('-ac'));
  assert.strictEqual(wavAsrArgs[wavAsrArgs.indexOf('-ac') + 1], '1');
  assert.strictEqual(wavAsrArgs[wavAsrArgs.indexOf('-c:a') + 1], 'pcm_s16le');

  console.log('All audioExtractor tests passed successfully!');
}

runTests();
