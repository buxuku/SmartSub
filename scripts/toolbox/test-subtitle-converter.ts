import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import iconv from 'iconv-lite';
import {
  convertSubtitleFile,
  cleanSubtitleFormatting,
  previewSubtitleFile,
} from '../../main/helpers/toolbox/subtitleConverter';

async function runTests() {
  console.log('Running subtitleConverter tests...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-test-converter-'));

  try {
    // 1. 样式清洗测试
    const rawStyled = '{\\an8\\pos(100,200)}<i>你好</i> <b>世界</b>！\\N第二行';
    const cleaned = cleanSubtitleFormatting(rawStyled);
    assert.strictEqual(cleaned, '你好 世界！\n第二行');

    // 2. 创建一个 GBK 编码的 SRT 测试文件
    const srtContent = `1
00:00:01,000 --> 00:00:03,500
这是第一句中文字幕。

2
00:00:04,000 --> 00:00:06,000
这是第二句中文字幕。
`;
    const gbkPath = path.join(tmpDir, 'test_gbk.srt');
    fs.writeFileSync(gbkPath, iconv.encode(srtContent, 'gbk'));

    // 测试预览
    const preview = await previewSubtitleFile(gbkPath);
    assert.strictEqual(preview.cues.length, 2);
    assert.strictEqual(preview.encoding, 'GB18030');
    assert.strictEqual(preview.cues[0].text, '这是第一句中文字幕。');

    // 3. 转换 GBK SRT 为 UTF-8 VTT
    const r1 = await convertSubtitleFile({
      filePath: gbkPath,
      targetFormat: 'vtt',
      targetEncoding: 'utf-8',
      chineseConversion: 's2t',
      outputDir: tmpDir,
    });

    assert.strictEqual(r1.success, true);
    assert.ok(r1.outputPath && fs.existsSync(r1.outputPath));
    assert.strictEqual(path.extname(r1.outputPath), '.vtt');
    const vttContent = fs.readFileSync(r1.outputPath, 'utf-8');
    assert.ok(vttContent.startsWith('WEBVTT'));
    assert.ok(vttContent.includes('這是第一句中文字幕')); // s2t 繁体转换成功

    // 4. 转换为纯文本 TXT（不含时间轴）
    const r2 = await convertSubtitleFile({
      filePath: gbkPath,
      targetFormat: 'txt',
      targetEncoding: 'utf-8',
      includeTimestampsInTxt: false,
      outputDir: tmpDir,
    });

    assert.strictEqual(r2.success, true);
    const txtContent = fs.readFileSync(r2.outputPath!, 'utf-8');
    assert.strictEqual(
      txtContent.trim(),
      '这是第一句中文字幕。\n\n这是第二句中文字幕。',
    );

    console.log('All subtitleConverter tests passed successfully!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
