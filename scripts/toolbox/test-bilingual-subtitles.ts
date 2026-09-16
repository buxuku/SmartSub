import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  mergeBilingualSubtitles,
  splitBilingualSubtitles,
} from '../../main/helpers/toolbox/bilingualSubtitles';

async function runTests() {
  console.log('Running bilingualSubtitles tests...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-test-bi-'));

  try {
    const pPath = path.join(tmpDir, 'primary.srt');
    const sPath = path.join(tmpDir, 'secondary.srt');

    fs.writeFileSync(
      pPath,
      '1\n00:00:01,000 --> 00:00:03,000\nHello World\n',
      'utf-8',
    );
    fs.writeFileSync(
      sPath,
      '1\n00:00:01,200 --> 00:00:02,900\n你好世界\n',
      'utf-8',
    );

    // 1. 测试合并
    const mergeRes = await mergeBilingualSubtitles({
      primaryPath: pPath,
      secondaryPath: sPath,
      primaryPosition: 'top',
      outputPath: path.join(tmpDir, 'merged.srt'),
    });
    assert.strictEqual(mergeRes.success, true);
    assert.strictEqual(mergeRes.cuesCount, 1);
    const mergedContent = fs.readFileSync(mergeRes.outputPaths[0], 'utf-8');
    assert.ok(mergedContent.includes('Hello World\n你好世界'));

    // 2. 测试拆分
    const splitRes = await splitBilingualSubtitles({
      filePath: mergeRes.outputPaths[0],
      outputDir: tmpDir,
    });
    assert.strictEqual(splitRes.success, true);
    assert.strictEqual(splitRes.outputPaths.length, 2);

    const part1 = fs.readFileSync(splitRes.outputPaths[0], 'utf-8');
    const part2 = fs.readFileSync(splitRes.outputPaths[1], 'utf-8');
    assert.ok(part1.includes('Hello World'));
    assert.ok(!part1.includes('你好世界'));
    assert.ok(part2.includes('你好世界'));
    assert.ok(!part2.includes('Hello World'));

    const beforeFailure = fs.readdirSync(tmpDir).sort();
    const originalOpen = fs.openSync;
    try {
      fs.openSync = ((file, ...args) => {
        if (String(file).includes('_part2'))
          throw Object.assign(new Error('Test output reservation denied'), {
            code: 'EACCES',
          });
        return originalOpen(file, ...args);
      }) as typeof fs.openSync;
      const failed = await splitBilingualSubtitles({
        filePath: mergeRes.outputPaths[0],
        outputDir: tmpDir,
      });
      assert.equal(failed.success, false);
      assert.match(failed.error!, /reservation denied/);
      assert.deepEqual(
        fs.readdirSync(tmpDir).sort(),
        beforeFailure,
        'second reservation failure removes first placeholder only',
      );
    } finally {
      fs.openSync = originalOpen;
    }
    fs.writeFileSync(sPath, 'No subtitle timestamps');
    const emptySecondary = await mergeBilingualSubtitles({
      primaryPath: pPath,
      secondaryPath: sPath,
    });
    assert.equal(emptySecondary.success, false);
    assert.deepEqual(emptySecondary.outputPaths, []);

    console.log('All bilingualSubtitles tests passed successfully!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
