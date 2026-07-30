/// <reference path="./test-globals.d.ts" />
/**
 * 文稿匹配纯逻辑 + 文件/IPC 契约测试（无 Electron、无网络）。
 *
 * 覆盖：
 * - task config 缺省关闭、路径快照解析
 * - Markdown 可见文本规范化与分段
 * - 单调对齐、分句粒度差异、远端锚点恢复、高/低置信安全边界
 * - 匹配只改 text，时间轴/额外 cue 字段不变
 * - UTF-8 / UTF-16 文稿读取、扩展名/空文稿校验
 * - IPC selection payload 不携带文稿正文
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ManuscriptFileError,
  getManuscriptConfig,
  matchManuscriptToCues,
  normalizeManuscriptText,
  readManuscriptFile,
  segmentManuscript,
  toManuscriptSelectionPayload,
} from '../main/helpers/manuscriptMatching';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed += 1;
  } else {
    failed += 1;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function ok(condition: boolean, name: string): void {
  eq(Boolean(condition), true, name);
}

function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

async function expectFileError(
  promise: Promise<unknown>,
  code: string,
  name: string,
): Promise<void> {
  try {
    await promise;
    eq('resolved', code, name);
  } catch (error) {
    eq(
      error instanceof ManuscriptFileError ? error.code : 'unknown',
      code,
      name,
    );
  }
}

async function run(): Promise<void> {
  // config / snapshot
  eq(getManuscriptConfig(undefined), null, 'config: 缺省关闭');
  eq(getManuscriptConfig({ manuscriptPath: '   ' }), null, 'config: 空白关闭');
  eq(
    getManuscriptConfig({
      manuscriptPath: ' C:\\scripts\\episode.md ',
      manuscriptName: ' 第一期.md ',
    }),
    { path: 'C:\\scripts\\episode.md', name: '第一期.md' },
    'config: 路径与显示名 trim 后进入任务快照',
  );

  // normalization / segmentation
  const markdown = [
    '---',
    'title: hidden metadata',
    '---',
    '# 第一章',
    '- 欢迎阅读 **SmartSub**。',
    '[文档链接](https://example.com)不会保留网址。',
  ].join('\n');
  const normalizedMarkdown = normalizeManuscriptText(markdown, true);
  ok(
    !normalizedMarkdown.includes('title: hidden'),
    'markdown: frontmatter 移除',
  );
  ok(!normalizedMarkdown.includes('https://'), 'markdown: 链接 URL 移除');
  ok(
    normalizedMarkdown.includes('欢迎阅读 SmartSub'),
    'markdown: 可见文本保留',
  );
  eq(
    segmentManuscript('第一句。Second sentence. 最后一段').length,
    3,
    'segment: 中英文句末 + 尾段',
  );

  // exact/high-confidence matching with skipped title
  const sourceCues = [
    {
      text: '大家好欢迎收看本期视频',
      startMs: 0,
      endMs: 2100,
      speaker: 'A',
    },
    {
      text: '今天我们介绍文稿匹配功嫩',
      startMs: 2100,
      endMs: 4800,
      speaker: 'A',
    },
    {
      text: '这个功能会保留原来的时间轴',
      startMs: 4800,
      endMs: 7200,
      speaker: 'B',
    },
  ];
  const matched = matchManuscriptToCues(
    sourceCues,
    [
      '第一章：产品介绍',
      '大家好，欢迎收看本期视频。',
      '今天我们介绍文稿匹配功能。',
      '这个功能会保留原来的时间轴。',
    ].join('\n'),
  );
  eq(matched.replacedCues, 3, 'align: 标题可跳过，三条高置信替换');
  eq(
    matched.cues.map((cue) => [cue.startMs, cue.endMs]),
    sourceCues.map((cue) => [cue.startMs, cue.endMs]),
    'invariant: 时间轴完全不变',
  );
  eq(
    matched.cues.map((cue) => cue.speaker),
    ['A', 'A', 'B'],
    'invariant: cue 额外字段保留',
  );
  ok(
    comparable(matched.cues.map((cue) => cue.text).join('')).includes(
      comparable('文稿匹配功能'),
    ),
    'align: ASR 错字由文稿纠正',
  );

  // two cues to one manuscript sentence
  const regrouped = matchManuscriptToCues(
    [
      { text: 'hello world', startMs: 0, endMs: 1000 },
      { text: 'this is a test', startMs: 1000, endMs: 2200 },
    ],
    'Hello, world, this is a test.',
  );
  eq(regrouped.replacedCues, 2, 'align: 2 cue ↔ 1 文稿单元');
  eq(
    comparable(regrouped.cues.map((cue) => cue.text).join('')),
    comparable('Hello, world, this is a test.'),
    'align: 重新分配文稿文本不丢字',
  );
  ok(
    regrouped.cues.every((cue) => cue.text.trim().length > 0),
    'align: 1 文稿单元按 cue 权重安全分配',
  );

  const mergedUnits = matchManuscriptToCues(
    [
      {
        text: 'alpha beta gamma delta',
        startMs: 0,
        endMs: 2200,
      },
    ],
    'Alpha beta. Gamma delta.',
  );
  eq(mergedUnits.replacedCues, 1, 'align: 1 cue ↔ 2 文稿单元');
  ok(
    mergedUnits.cues[0].text.includes('. Gamma'),
    'align: 英文文稿单元合并时保留可读空格',
  );

  // Far anchor recovery after many unspoken units.
  const gapScript = [
    'First spoken sentence.',
    ...Array.from(
      { length: 35 },
      (_, index) => `Unspoken stage direction number ${index}.`,
    ),
    'Second spoken sentence after the long omitted section.',
  ].join('\n');
  const recovered = matchManuscriptToCues(
    [
      { text: 'first spoken sentence', startMs: 0, endMs: 1000 },
      {
        text: 'second spoken sentence after the long omitted section',
        startMs: 9000,
        endMs: 12000,
      },
    ],
    gapScript,
  );
  eq(recovered.replacedCues, 2, 'align: 超过局部窗口后由稀有三元组锚点恢复');

  const unrelated = [
    { text: 'completely unrelated recognition', startMs: 0, endMs: 1000 },
  ];
  const safeFallback = matchManuscriptToCues(
    unrelated,
    '正确文稿描述的是另一段完全不同的内容。',
  );
  eq(safeFallback.replacedCues, 0, 'safety: 低置信不替换');
  eq(safeFallback.cues, unrelated, 'safety: 低置信完整回退原 ASR');

  const uniqueModerate = matchManuscriptToCues(
    [{ text: 'the product is redy for lunch today' }],
    'The project is ready for launch today.',
  );
  eq(
    uniqueModerate.replacedCues,
    1,
    'margin: 同一位置的不同分组不被误算成次优位置',
  );
  const repeatedModerate = matchManuscriptToCues(
    [{ text: 'the product is redy for lunch today' }],
    [
      'The project is ready for launch today.',
      'A stage direction that is not spoken.',
      'The project is ready for launch today.',
    ].join('\n'),
  );
  eq(
    repeatedModerate.replacedCues,
    0,
    'margin: 两个不同位置近似等价时安全拒配',
  );

  const localeStable = matchManuscriptToCues(
    [{ text: 'istanbul integration is deterministic' }],
    'Istanbul integration is deterministic.',
  );
  eq(localeStable.replacedCues, 1, 'normalization: 大小写不随系统区域变化');

  // File + IPC contract.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-manuscript-'));
  try {
    const utf8Path = path.join(tmpDir, 'episode.md');
    fs.writeFileSync(utf8Path, '# 标题\n\n大家好，欢迎收看。', 'utf-8');
    const utf8 = await readManuscriptFile(utf8Path);
    eq(utf8.encoding, 'utf-8', 'file: UTF-8 识别');
    eq(utf8.text, '标题\n\n大家好，欢迎收看。', 'file: Markdown 读取并规范化');

    const payload = toManuscriptSelectionPayload(utf8);
    eq(
      Object.prototype.hasOwnProperty.call(payload, 'text'),
      false,
      'ipc: selection payload 不回传/持久化正文',
    );
    eq(payload.path, utf8Path, 'ipc: selection payload 返回绝对路径');
    ok(payload.characterCount > 0 && payload.size > 0, 'ipc: 返回校验元数据');

    const utf16Path = path.join(tmpDir, 'utf16.txt');
    const utf16Body = Buffer.from('UTF16 参考文稿', 'utf16le');
    fs.writeFileSync(
      utf16Path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Body]),
    );
    const utf16 = await readManuscriptFile(utf16Path);
    eq(utf16.encoding, 'utf-16le', 'file: UTF-16LE BOM 识别');
    eq(utf16.text, 'UTF16 参考文稿', 'file: UTF-16LE 正文');

    const utf16BePath = path.join(tmpDir, 'utf16be.txt');
    const utf16BeBody = Buffer.from('UTF16BE 文稿', 'utf16le');
    for (let index = 0; index + 1 < utf16BeBody.length; index += 2) {
      const first = utf16BeBody[index];
      utf16BeBody[index] = utf16BeBody[index + 1];
      utf16BeBody[index + 1] = first;
    }
    fs.writeFileSync(
      utf16BePath,
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBody]),
    );
    const utf16Be = await readManuscriptFile(utf16BePath);
    eq(utf16Be.encoding, 'utf-16be', 'file: UTF-16BE BOM 识别');
    eq(utf16Be.text, 'UTF16BE 文稿', 'file: UTF-16BE 正文');

    const gb18030Path = path.join(tmpDir, 'gb18030.txt');
    // “中文文稿”的 GBK 字节；GB18030 解码器是 GBK 的超集。
    fs.writeFileSync(
      gb18030Path,
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xb8, 0xe5]),
    );
    const gb18030 = await readManuscriptFile(gb18030Path);
    eq(gb18030.encoding, 'gb18030', 'file: GBK/GB18030 回退识别');
    eq(gb18030.text, '中文文稿', 'file: GB18030 正文');

    const unsupportedPath = path.join(tmpDir, 'episode.rtf');
    fs.writeFileSync(unsupportedPath, 'text', 'utf-8');
    await expectFileError(
      readManuscriptFile(unsupportedPath),
      'unsupported',
      'file: 非白名单扩展名拒绝',
    );

    const emptyPath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(emptyPath, ' \r\n\t', 'utf-8');
    await expectFileError(
      readManuscriptFile(emptyPath),
      'empty',
      'file: 空文稿拒绝',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nmanuscript matching: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
