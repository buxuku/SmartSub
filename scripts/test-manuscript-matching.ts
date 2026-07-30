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
  MANUSCRIPT_MAX_BYTES,
  MANUSCRIPT_MAX_COMPARABLE_CHARS,
  MANUSCRIPT_MAX_UNITS,
  ManuscriptFileError,
  getManuscriptConfig,
  matchManuscriptToCues,
  normalizeManuscriptText,
  readManuscriptFile,
  replaceMatchedSrtCueTexts,
  segmentManuscript,
  toManuscriptSelectionPayload,
} from '../main/helpers/manuscriptMatching';
import { atomicReplaceTextFile } from '../main/helpers/atomicFile';
import {
  isPinnedTaskConfigSnapshot,
  omitTaskManuscript,
} from '../types/taskConfig';

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
    (await segmentManuscript('第一句。Second sentence. 最后一段')).length,
    3,
    'segment: 中英文句末 + 尾段',
  );

  const longUnpunctuated = 'a'.repeat(128 * 1024);
  const segmentStartedAt = Date.now();
  const longUnits = await segmentManuscript(longUnpunctuated);
  const segmentElapsed = Date.now() - segmentStartedAt;
  eq(
    longUnits.join(''),
    longUnpunctuated,
    'segment: 无标点长段线性切分且不丢字',
  );
  ok(
    segmentElapsed < 5000,
    `performance: 128 KiB 无标点分段应在 5 秒内完成（实际 ${segmentElapsed}ms）`,
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
  const matched = await matchManuscriptToCues(
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
  const regrouped = await matchManuscriptToCues(
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

  const mergedUnits = await matchManuscriptToCues(
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
  const recovered = await matchManuscriptToCues(
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
  const safeFallback = await matchManuscriptToCues(
    unrelated,
    '正确文稿描述的是另一段完全不同的内容。',
  );
  eq(safeFallback.replacedCues, 0, 'safety: 低置信不替换');
  eq(safeFallback.cues, unrelated, 'safety: 低置信完整回退原 ASR');

  const uniqueModerate = await matchManuscriptToCues(
    [{ text: 'the product is redy for lunch today' }],
    'The project is ready for launch today.',
  );
  eq(
    uniqueModerate.replacedCues,
    1,
    'margin: 同一位置的不同分组不被误算成次优位置',
  );
  const repeatedModerate = await matchManuscriptToCues(
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

  const localeStable = await matchManuscriptToCues(
    [{ text: 'istanbul integration is deterministic' }],
    'Istanbul integration is deterministic.',
  );
  eq(localeStable.replacedCues, 1, 'normalization: 大小写不随系统区域变化');

  const reorderedClauses = await matchManuscriptToCues(
    [
      { text: '我们先介绍中文', startMs: 0, endMs: 1000 },
      { text: '然后介绍英文最后总结', startMs: 1000, endMs: 2000 },
    ],
    '我们先介绍英文然后介绍中文最后总结',
  );
  eq(
    reorderedClauses.replacedCues,
    0,
    'safety: bigram 集合相同但词序互换时不得替换',
  );
  const longReorderedClauses = await matchManuscriptToCues(
    [
      {
        text: '在本课程的第一部分我们先介绍中文然后介绍英文最后总结全部内容谢谢大家',
      },
    ],
    '在本课程的第一部分我们先介绍英文然后介绍中文最后总结全部内容谢谢大家',
  );
  eq(
    longReorderedClauses.replacedCues,
    0,
    'safety: 长上下文不能稀释词序互换风险',
  );
  const threeCueLocalReorder = await matchManuscriptToCues(
    [
      {
        text: '在这次完整详细的课程讲解当中我们会依次讨论所有重',
      },
      {
        text: '要内容并且先介绍中文然后介绍英文最后总结全部内容并',
      },
      {
        text: '给出实践建议方便大家理解和应用这些知识解决真实问题',
      },
    ],
    '在这次完整详细的课程讲解当中我们会依次讨论所有重要内容并且先介绍英文然后介绍中文最后总结全部内容并给出实践建议方便大家理解和应用这些知识解决真实问题',
  );
  eq(
    threeCueLocalReorder.replacedCues,
    0,
    'safety: 3 cue 长上下文中的局部词序互换不得被稀释',
  );
  const longTwoCharacterWordReorder = await matchManuscriptToCues(
    [
      {
        text: '在这次完整详细的课程讲解当中我们会依次讨论所有重要内容并且先说明苹果然后结合案例详细讨论香蕉最后总结全部内容并给出实践建议方便大家理解和应用这些知识解决真实问题',
      },
    ],
    '在这次完整详细的课程讲解当中我们会依次讨论所有重要内容并且先说明香蕉然后结合案例详细讨论苹果最后总结全部内容并给出实践建议方便大家理解和应用这些知识解决真实问题',
  );
  eq(
    longTwoCharacterWordReorder.replacedCues,
    0,
    'safety: 长上下文中的两个双字词换位不得被稀释',
  );
  const mediumTwoCharacterWordReorder = await matchManuscriptToCues(
    [
      {
        text: '今天我们会先分析需求然后逐步说明设计最后结合实例验证全部流程确保每一位学习者都能理解核心方法并正确应用',
      },
    ],
    '今天我们会先分析设计然后逐步说明需求最后结合实例验证全部流程确保每一位学习者都能理解核心方法并正确应用',
  );
  eq(
    mediumTwoCharacterWordReorder.replacedCues,
    0,
    'safety: 中等上下文中的两个双字词换位不得被稀释',
  );
  const alignedTypo = await matchManuscriptToCues(
    [{ text: '今天我们介少文稿匹配功能' }],
    '今天我们介绍文稿匹配功能',
  );
  eq(
    alignedTypo.replacedCues,
    1,
    'order gate: 保留按原顺序的一处中段 ASR 错字校正能力',
  );
  const tenCharacterSubstitution = await matchManuscriptToCues(
    [{ text: '今天介绍文稿匹陪功能' }],
    '今天介绍文稿匹配功能',
  );
  eq(
    tenCharacterSubstitution.replacedCues,
    1,
    'single edit: 10 字文本的一处替换与增删使用相同预算',
  );
  const missingCharacter = await matchManuscriptToCues(
    [{ text: '今天我们介绍文匹配功能' }],
    '今天我们介绍文稿匹配功能',
  );
  eq(
    missingCharacter.replacedCues,
    1,
    'single edit: 短句漏识一个汉字仍可由文稿校正',
  );
  const extraCharacter = await matchManuscriptToCues(
    [{ text: '今天我们介绍文稿稿匹配功能' }],
    '今天我们介绍文稿匹配功能',
  );
  eq(
    extraCharacter.replacedCues,
    1,
    'single edit: 短句多识一个汉字与漏识对称容错',
  );
  const unsafeShortSingleEdit = await matchManuscriptToCues(
    [{ text: '今天介绍文匹配功能' }],
    '今天介绍文稿匹配功能',
  );
  eq(
    unsafeShortSingleEdit.replacedCues,
    0,
    'single edit safety: 过短文本不放宽一个汉字的编辑预算',
  );
  const unsafeShortSubstitution = await matchManuscriptToCues(
    [{ text: '今天介绍稿匹陪功能' }],
    '今天介绍稿匹配功能',
  );
  eq(
    unsafeShortSubstitution.replacedCues,
    0,
    'single edit safety: 过短文本的一处替换同样不放宽',
  );
  const repeatedNgramSingleEdit = await matchManuscriptToCues(
    [{ text: '哈哈哈哈今天我们介绍文匹配功能哈哈哈哈' }],
    '哈哈哈哈今天我们介绍文稿匹配功能哈哈哈哈',
  );
  eq(
    repeatedNgramSingleEdit.replacedCues,
    1,
    'order anchors: 重复三元组不应让正常单字符增删产生伪换序',
  );
  // Two aligned substitutions in repeated content leave one coincidental
  // off-LIS anchor (displacement 10), which is noise rather than a supported
  // local reorder.
  const coincidentalAnchorCrossing = await matchManuscriptToCues(
    [{ text: '丁丙甲戊甲丙甲戊丙戊丁丙甲甲甲丙丁' }],
    '丁丙甲戊乙丙甲戊丙戊丁丙甲甲甲丙甲',
  );
  eq(
    coincidentalAnchorCrossing.replacedCues,
    1,
    'order anchors: 单个偶然 crossing 不足以判定局部换序',
  );
  const twoAlignedSubstitutions = await matchManuscriptToCues(
    [{ text: '甲丙丙戊丁甲甲丙甲丙甲丁丙甲甲乙丙戊甲丁丙丙乙' }],
    '甲乙丙戊丁甲甲丙甲丙甲丁丙甲甲乙甲戊甲丁丙丙乙',
  );
  eq(
    twoAlignedSubstitutions.replacedCues,
    1,
    'order anchors: 两处普通错字不得被误判为局部换序',
  );

  const cancellation = new AbortController();
  const cancellationPromise = matchManuscriptToCues(
    Array.from({ length: 500 }, () => ({
      text: 'a repeated cue that requires matching work',
    })),
    'a'.repeat(128 * 1024),
    { signal: cancellation.signal },
  );
  setTimeout(() => cancellation.abort(), 0);
  try {
    await cancellationPromise;
    eq('resolved', 'AbortError', 'cancel: 计算中应响应 AbortSignal');
  } catch (error) {
    eq((error as Error).name, 'AbortError', 'cancel: 计算中响应 AbortSignal');
  }

  const originalSrt = [
    '7',
    '00:00:00,000 --> 00:00:01,000',
    'unmatched first line',
    'unmatched second line',
    '',
    '9',
    '00:00:01,000 --> 00:00:02,000',
    'old matched text',
    '',
  ].join('\r\n');
  const patchedSrt = replaceMatchedSrtCueTexts(
    originalSrt,
    new Map([[1, 'corrected matched text']]),
  );
  eq(
    patchedSrt,
    originalSrt.replace('old matched text', 'corrected matched text'),
    'srt: 仅替换命中 cue，未命中多行/序号/时间/CRLF 原样保留',
  );

  eq(
    omitTaskManuscript({
      model: 'base',
      manuscriptPath: 'C:\\private\\episode.md',
      manuscriptName: 'episode.md',
    }),
    { model: 'base' },
    'config: 文稿路径不进入全局 userConfig',
  );
  ok(
    isPinnedTaskConfigSnapshot({
      manuscriptPath: 'C:\\private\\episode.md',
    }),
    'config: 带文稿的任务快照固定',
  );
  eq(
    isPinnedTaskConfigSnapshot({ model: 'base' }),
    false,
    'config: 普通任务配置仍可编辑',
  );

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
    eq(
      Object.prototype.hasOwnProperty.call(payload, 'units'),
      false,
      'ipc: selection payload 不回传预分段正文',
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

    const oversizedPath = path.join(tmpDir, 'oversized.txt');
    fs.writeFileSync(
      oversizedPath,
      Buffer.alloc(MANUSCRIPT_MAX_BYTES + 1, 0x61),
    );
    await expectFileError(
      readManuscriptFile(oversizedPath),
      'tooLarge',
      'file: 1 MiB raw cap',
    );

    const grewAfterStatPath = path.join(tmpDir, 'grew-after-stat.txt');
    fs.writeFileSync(grewAfterStatPath, 'small', 'utf-8');
    const originalReadFile = fs.promises.readFile;
    (fs.promises as any).readFile = async (
      requestedPath: fs.PathLike,
      ...args: unknown[]
    ) =>
      requestedPath === grewAfterStatPath
        ? Buffer.alloc(MANUSCRIPT_MAX_BYTES + 1, 0x61)
        : (originalReadFile as any)(requestedPath, ...args);
    try {
      await expectFileError(
        readManuscriptFile(grewAfterStatPath),
        'tooLarge',
        'file: stat 后增长仍由实际 buffer 大小拒绝',
      );
    } finally {
      (fs.promises as any).readFile = originalReadFile;
    }

    const tooManyCharactersPath = path.join(tmpDir, 'too-many-chars.txt');
    fs.writeFileSync(
      tooManyCharactersPath,
      'a'.repeat(MANUSCRIPT_MAX_COMPARABLE_CHARS + 1),
      'utf-8',
    );
    await expectFileError(
      readManuscriptFile(tooManyCharactersPath),
      'tooComplex',
      'file: 规范化后 comparable 字符上限',
    );

    const tooManyUnitsPath = path.join(tmpDir, 'too-many-units.txt');
    fs.writeFileSync(
      tooManyUnitsPath,
      Array.from({ length: MANUSCRIPT_MAX_UNITS + 1 }, () => 'a.').join('\n'),
      'utf-8',
    );
    await expectFileError(
      readManuscriptFile(tooManyUnitsPath),
      'tooComplex',
      'file: 文稿分段单元上限',
    );

    const atomicPath = path.join(tmpDir, 'atomic.srt');
    fs.writeFileSync(atomicPath, 'original subtitle', 'utf-8');
    await atomicReplaceTextFile(atomicPath, 'replacement subtitle');
    eq(
      fs.readFileSync(atomicPath, 'utf-8'),
      'replacement subtitle',
      'atomic: flush/close 后替换成功',
    );
    fs.writeFileSync(atomicPath, 'must survive rename failure', 'utf-8');
    try {
      await atomicReplaceTextFile(atomicPath, 'must not become visible', {
        operations: {
          open: fs.promises.open.bind(fs.promises),
          rm: fs.promises.rm.bind(fs.promises),
          rename: async () => {
            throw new Error('simulated rename failure');
          },
        } as any,
      });
      eq('resolved', 'rejected', 'atomic: rename failure should reject');
    } catch {
      eq(
        fs.readFileSync(atomicPath, 'utf-8'),
        'must survive rename failure',
        'atomic: rename failure leaves original untouched',
      );
    }
    eq(
      fs
        .readdirSync(tmpDir)
        .some(
          (name) => name.startsWith('.atomic.srt.') && name.endsWith('.tmp'),
        ),
      false,
      'atomic: failure cleans sibling temp',
    );

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
