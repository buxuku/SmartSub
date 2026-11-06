import assert from 'assert';
import {
  formatFfmpegTime,
  buildTrimArgs,
} from '../../main/helpers/toolbox/videoTrimmer';

function runTests() {
  console.log('Running videoTrimmer tests...');

  // 1. 测试时间格式化
  assert.strictEqual(formatFfmpegTime(0), '00:00:00.000');
  assert.strictEqual(formatFfmpegTime(65.5), '00:01:05.500');
  assert.strictEqual(formatFfmpegTime(3661.123), '01:01:01.123');

  // 2. 测试无损流拷贝命令行构建
  const losslessArgs = buildTrimArgs(
    {
      videoPath: '/path/to/test.mp4',
      startSec: 10,
      endSec: 25.5,
      mode: 'lossless',
    },
    '/path/to/out.mp4',
  );

  assert.ok(losslessArgs.includes('-c'));
  assert.strictEqual(losslessArgs[losslessArgs.indexOf('-c') + 1], 'copy');
  assert.ok(losslessArgs.includes('-avoid_negative_ts'));
  assert.strictEqual(losslessArgs[losslessArgs.length - 1], '/path/to/out.mp4');

  // 3. 测试精确重编码模式（-i 在 -ss 之前，逐帧解码精确对齐）
  const accurateArgs = buildTrimArgs(
    {
      videoPath: '/path/to/test.mp4',
      startSec: 10,
      endSec: 25.5,
      mode: 'accurate',
    },
    '/path/to/out.mp4',
  );

  const idxI = accurateArgs.indexOf('-i');
  const idxSS = accurateArgs.indexOf('-ss');
  assert.ok(idxI !== -1 && idxSS !== -1 && idxI < idxSS, '-i must precede -ss for output seeking in accurate mode');
  assert.ok(accurateArgs.includes('-c:v'));
  assert.strictEqual(accurateArgs[accurateArgs.indexOf('-c:v') + 1], 'libx264');
  assert.ok(accurateArgs.includes('-c:a'));
  assert.strictEqual(accurateArgs[accurateArgs.indexOf('-c:a') + 1], 'aac');

  console.log('All videoTrimmer tests passed successfully!');
}

runTests();
