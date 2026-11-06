import assert from 'assert';
import iconv from 'iconv-lite';
import {
  detectBufferEncoding,
  decodeBufferToString,
  encodeStringToBuffer,
} from '../../main/helpers/toolbox/encodingDetector';

function runTests() {
  console.log('Running encodingDetector tests...');

  // 1. 测试标准 UTF-8
  const utf8Text = '1\n00:00:01,000 --> 00:00:04,000\n你好，世界！Hello World.';
  const utf8Buf = Buffer.from(utf8Text, 'utf-8');
  const r1 = detectBufferEncoding(utf8Buf);
  assert.strictEqual(r1.encoding, 'UTF-8');
  assert.strictEqual(r1.hasBom, false);
  const d1 = decodeBufferToString(utf8Buf);
  assert.strictEqual(d1.text, utf8Text);

  // 2. 测试带 BOM 的 UTF-8
  const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Buf]);
  const r2 = detectBufferEncoding(bomBuf);
  assert.strictEqual(r2.encoding, 'UTF-8 with BOM');
  assert.strictEqual(r2.hasBom, true);
  const d2 = decodeBufferToString(bomBuf);
  assert.strictEqual(d2.text, utf8Text); // BOM 应被自动剔除

  // 3. 测试 GBK / GB18030
  const gbkText = '中文字幕测试，包含常见汉字以及标点符号。';
  const gbkBuf = iconv.encode(gbkText, 'gbk');
  const r3 = detectBufferEncoding(gbkBuf);
  assert.strictEqual(r3.encoding, 'GB18030');
  assert.strictEqual(r3.hasBom, false);
  const d3 = decodeBufferToString(gbkBuf);
  assert.strictEqual(d3.text, gbkText);

  // 4. 测试 Big5
  const big5Text = '繁體中文字幕測試，轉換繁體。';
  const big5Buf = iconv.encode(big5Text, 'big5');
  const r4 = detectBufferEncoding(big5Buf);
  assert.ok(r4.encoding === 'Big5' || r4.encoding === 'GB18030');
  const d4 = decodeBufferToString(big5Buf, 'big5');
  assert.strictEqual(d4.text, big5Text);

  // 5. 测试编码回写
  const outUtf8Bom = encodeStringToBuffer('测试BOM', 'utf-8-bom');
  assert.strictEqual(outUtf8Bom[0], 0xef);
  assert.strictEqual(outUtf8Bom[1], 0xbb);
  assert.strictEqual(outUtf8Bom[2], 0xbf);

  const outGbk = encodeStringToBuffer('中文测试\n换行', 'gb18030');
  const backGbk = iconv.decode(outGbk, 'gb18030');
  assert.strictEqual(backGbk, '中文测试\r\n换行');

  console.log('All encodingDetector tests passed successfully!');
}

runTests();
