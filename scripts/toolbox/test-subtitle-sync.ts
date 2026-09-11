import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncCues, executeSubtitleSync } from '../../main/helpers/toolbox/subtitleSync';
import type { SubtitleCue } from '../../main/helpers/subtitleFormats';

async function runTests() {
  console.log('Running subtitleSync tests...');

  const sampleCues: SubtitleCue[] = [
    { startMs: 1000, endMs: 3000, text: 'Hello' },
    { startMs: 5000, endMs: 8000, text: 'World' },
  ];

  // 1. 测试整体平移 (+500ms)
  const offsetCues = syncCues(sampleCues, {
    filePath: '',
    mode: 'offset',
    offsetMs: 500,
  });
  assert.strictEqual(offsetCues[0].startMs, 1500);
  assert.strictEqual(offsetCues[0].endMs, 3500);
  assert.strictEqual(offsetCues[1].startMs, 5500);
  assert.strictEqual(offsetCues[1].endMs, 8500);

  // 2. 测试比例伸缩 (2x)
  const scaleCues = syncCues(sampleCues, {
    filePath: '',
    mode: 'scale',
    scaleRatio: 2.0,
  });
  assert.strictEqual(scaleCues[0].startMs, 2000);
  assert.strictEqual(scaleCues[0].endMs, 6000);
  assert.strictEqual(scaleCues[1].startMs, 10000);
  assert.strictEqual(scaleCues[1].endMs, 16000);

  // 3. 测试双锚点重采样
  // 假设原来首句 1000 目标 2000，原来尾句 5000 目标 10000
  const twoPointCues = syncCues(sampleCues, {
    filePath: '',
    mode: 'two-point',
    p1SourceMs: 1000,
    p1TargetMs: 2000,
    p2SourceMs: 5000,
    p2TargetMs: 10000,
  });
  assert.strictEqual(twoPointCues[0].startMs, 2000);
  assert.strictEqual(twoPointCues[1].startMs, 10000);

  // 4. 测试完整文件执行
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-test-sync-'));
  try {
    const srtPath = path.join(tmpDir, 'test.srt');
    fs.writeFileSync(
      srtPath,
      '1\n00:00:01,000 --> 00:00:03,000\nLine 1\n\n2\n00:00:04,000 --> 00:00:06,000\nLine 2\n',
      'utf-8',
    );
    const res = await executeSubtitleSync({
      filePath: srtPath,
      mode: 'offset',
      offsetMs: 1000,
      outputPath: path.join(tmpDir, 'test_out.srt'),
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.cuesCount, 2);
    const content = fs.readFileSync(res.outputPath, 'utf-8');
    assert.ok(content.includes('00:00:02,000 --> 00:00:04,000'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('All subtitleSync tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
