/**
 * assStyleBuilder 单元验证（纯函数，无 electron 依赖）。
 * 运行：yarn test:ass-builder
 */

import {
  buildAssStyleLine,
  buildAssDocument,
  cssColorToAss,
  backOpacityToAssAlpha,
  convertAlignment,
} from '../main/helpers/assStyleBuilder';
import { parseSubtitleCues } from '../main/helpers/subtitleFormats';
import type { SubtitleStyle } from '../types/subtitleMerge';

let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : ` | expected=${expected} actual=${actual}`}`,
  );
}

function assertContains(haystack: string, needle: string, label: string) {
  const ok = haystack.includes(needle);
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : ` | missing: ${needle}`}`,
  );
}

const baseStyle: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#112233',
  backColor: '#FF0000',
  backOpacity: 30,
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 3,
  outline: 2,
  shadow: 0,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};

// --- alpha 换算 ---
assertEqual(backOpacityToAssAlpha(100), 0, 'opacity 100% → alpha 0x00');
assertEqual(backOpacityToAssAlpha(0), 255, 'opacity 0% → alpha 0xFF');
assertEqual(backOpacityToAssAlpha(30), 179, 'opacity 30% → alpha 179(0xB3)');
assertEqual(
  backOpacityToAssAlpha(undefined),
  128,
  '缺省 opacity → alpha 128（兼容旧版）',
);

// --- 颜色转换 ---
assertEqual(cssColorToAss('#FF0000', 179), '&HB30000FF', '红色 + alpha 0xB3');
assertEqual(cssColorToAss('#FFFFFF'), '&H00FFFFFF', '白色不透明');

// --- 对齐转换 ---
assertEqual(convertAlignment(2), 2, 'numpad 2（中下）→ ASS 2');
assertEqual(convertAlignment(5), 10, 'numpad 5（居中）→ ASS 10');
assertEqual(convertAlignment(8), 6, 'numpad 8（中上）→ ASS 6');

// --- Style 行：背景框模式（核心修复：OutlineColour 取背景色） ---
const boxStyleLine = buildAssStyleLine(baseStyle);
console.log(`\n[BorderStyle=3] ${boxStyleLine}\n`);
assertContains(
  boxStyleLine,
  ',&HB30000FF,&HB30000FF,',
  '背景框模式：OutlineColour 与 BackColour 均为 背景色+alpha',
);
assertContains(boxStyleLine, ',3,2,0,', 'BorderStyle=3 / Outline=2 / Shadow=0');

// --- 背景框模式 Outline=0 钳到 1（libass 仅在 border>0 时绘制背景框） ---
const zeroOutlineBoxLine = buildAssStyleLine({ ...baseStyle, outline: 0 });
assertContains(
  zeroOutlineBoxLine,
  ',3,1,0,',
  '背景框模式 Outline=0 → 钳到 1（保证框可见）',
);
const zeroOutlinePlainLine = buildAssStyleLine({
  ...baseStyle,
  borderStyle: 1,
  outline: 0,
});
assertContains(
  zeroOutlinePlainLine,
  ',1,0,0,',
  '边框+阴影模式 Outline=0 保持 0（无描边合法）',
);

// --- 背景框模式 Shadow 钳 0（避免同色偏移影子框） ---
const boxShadowLine = buildAssStyleLine({ ...baseStyle, shadow: 3 });
assertContains(
  boxShadowLine,
  ',3,2,0,',
  '背景框模式 Shadow=3 → 钳到 0（UI 不提供该项，所配即所得）',
);

// --- Style 行：边框+阴影模式（行为不变，阴影获得透明度） ---
const outlineStyleLine = buildAssStyleLine({
  ...baseStyle,
  borderStyle: 1,
  shadow: 1,
});
console.log(`\n[BorderStyle=1] ${outlineStyleLine}\n`);
assertContains(
  outlineStyleLine,
  ',&H00332211,&HB30000FF,',
  '边框+阴影模式：OutlineColour=描边色（不透明），BackColour=背景色+alpha',
);

// --- 完整文档 ---
const srt = `1
00:00:01,000 --> 00:00:03,500
第一行中文
Second line

2
00:00:05,000 --> 00:00:08,000
带{花括号}的文本
`;
const cues = parseSubtitleCues(srt, 'srt');
const doc = buildAssDocument(cues, baseStyle);
console.log('--- 生成的 ASS 文档 ---');
console.log(doc);
console.log('---');
assertContains(
  doc,
  'PlayResX: 384',
  'PlayResX=384（与 ffmpeg SRT 隐式转换一致）',
);
assertContains(doc, 'PlayResY: 288', 'PlayResY=288');
assertContains(doc, 'ScaledBorderAndShadow: yes', 'ScaledBorderAndShadow=yes');
assertContains(
  doc,
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,第一行中文\\NSecond line',
  '多行 cue 硬换行转 \\N',
);
assertContains(doc, '带｛花括号｝的文本', '花括号转全角避免被解析为覆盖标签');

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
