/**
 * 流水线阶段纯函数单元验证（无 electron/ffmpeg 依赖）。
 * 运行：yarn test:pipeline
 *
 * 覆盖：
 *  - dubTextSource：配音文本源优先级（纯译文中间产物 → sidecar 重建 →
 *    纯译文交付物 → 源字幕）、双语不可解、txt 拒绝、sidecar 译文列映射
 *  - deriveComposeConfig：矩阵推导（配音→替换+顺延字幕优先）、soft→mkv、
 *    none 无配音拒绝、-final 防覆盖命名
 */

import {
  pickDubTextSource,
  cuesFromSidecarTargets,
  taskHasTranslation,
} from '../../main/helpers/pipeline/dubTextSource';
import {
  deriveComposeConfig,
  finalOutputPath,
  pickComposeSubtitle,
  platformDefaultFont,
  resolveComposeRunOptions,
  DEFAULT_PIPELINE_STYLE,
} from '../../main/helpers/pipeline/deriveComposeConfig';
import {
  shouldDockAtSubtitleGate,
  shouldDockAtDubbingGate,
  filterReleasableFiles,
  countReviewFiles,
} from '../../main/helpers/pipeline/gateLogic';
import type { SubtitleStyle } from '../../types/subtitleMerge';

let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n   expected=${b}\n   actual  =${a}`}`,
  );
}

const existsIn = (present: string[]) => (p: string) => present.includes(p);

const STYLE: SubtitleStyle = {
  ...DEFAULT_PIPELINE_STYLE,
  fontName: platformDefaultFont('darwin'),
};

// ── taskHasTranslation ──────────────────────────────────────────────────────

eq(
  taskHasTranslation({
    taskType: 'generateAndTranslate',
    translateProvider: 'p1',
  }),
  true,
  'taskHasTranslation: 生成并翻译 + 有服务商',
);
eq(
  taskHasTranslation({ taskType: 'translateOnly', translateProvider: '-1' }),
  false,
  'taskHasTranslation: provider=-1 视为不翻译',
);
eq(
  taskHasTranslation({ taskType: 'generateOnly', translateProvider: 'p1' }),
  false,
  'taskHasTranslation: generateOnly 无翻译段',
);

// ── pickDubTextSource ───────────────────────────────────────────────────────

const T = { taskType: 'generateAndTranslate', translateProvider: 'p1' } as any;

eq(
  pickDubTextSource(
    {
      tempTranslatedSrtFile: '/tmp/pure.srt',
      translatedSrtFile: '/d/out.srt',
    } as any,
    T,
    existsIn(['/tmp/pure.srt', '/d/out.srt']),
  ),
  { type: 'ready', path: '/tmp/pure.srt' },
  'dub 文本源: 纯译文中间产物优先',
);

eq(
  pickDubTextSource(
    {
      tempTranslatedSrtFile: '/tmp/gone.srt',
      proofreadDataFile: '/d/.smartsub-proofread/a.json',
      translatedSrtFile: '/d/out.srt',
    } as any,
    T,
    existsIn(['/d/.smartsub-proofread/a.json', '/d/out.srt']),
  ),
  { type: 'sidecar', sidecarPath: '/d/.smartsub-proofread/a.json' },
  'dub 文本源: 中间产物缺失时经 sidecar 重建',
);

eq(
  pickDubTextSource(
    { translatedSrtFile: '/d/out.srt' } as any,
    { ...T, translateContent: 'onlyTranslate' },
    existsIn(['/d/out.srt']),
  ),
  { type: 'ready', path: '/d/out.srt' },
  'dub 文本源: 纯译文交付物（onlyTranslate）可直接使用',
);

eq(
  pickDubTextSource(
    { translatedSrtFile: '/d/out.srt' } as any,
    { ...T, translateContent: 'sourceAndTranslate' },
    existsIn(['/d/out.srt']),
  ),
  { type: 'error', reason: 'bilingual-unresolvable' },
  'dub 文本源: 仅双语交付物且无 sidecar → 不可解',
);

eq(
  pickDubTextSource(
    { srtFile: '/d/a.srt', filePath: '/d/a.mp4' } as any,
    { taskType: 'generateOnly', translateProvider: '-1' } as any,
    existsIn(['/d/a.srt']),
  ),
  { type: 'ready', path: '/d/a.srt' },
  'dub 文本源: 无翻译任务用源字幕',
);

eq(
  pickDubTextSource(
    { srtFile: '/d/a.txt', filePath: '/d/a.txt' } as any,
    { taskType: 'translateOnly', translateProvider: '-1' } as any,
    existsIn(['/d/a.txt']),
  ),
  { type: 'error', reason: 'missing-subtitle' },
  'dub 文本源: txt 无时间轴不可配音',
);

eq(
  cuesFromSidecarTargets([
    { id: '1', startMs: 0, endMs: 1000, source: 'Hello', target: ' 你好 ' },
    { id: '2', startMs: 1000, endMs: 2000, source: 'World', target: '' },
  ]),
  [
    { startMs: 0, endMs: 1000, text: '你好' },
    { startMs: 1000, endMs: 2000, text: '' },
  ],
  'sidecar 译文列映射: 取 target 并 trim，空译文保时间轴占位',
);

// ── finalOutputPath / pickComposeSubtitle ───────────────────────────────────

eq(
  finalOutputPath('/v/movie.mp4', '.mp4', existsIn([])),
  '/v/movie-final.mp4',
  '成品命名: <名>-final.<ext>',
);
eq(
  finalOutputPath('/v/movie.mp4', '.mp4', existsIn(['/v/movie-final.mp4'])),
  '/v/movie-final-2.mp4',
  '成品命名: 已存在时递增',
);

eq(
  pickComposeSubtitle(
    {
      shiftedSubtitlePath: '/s/shifted.srt',
      translatedSrtFile: '/s/out.srt',
      srtFile: '/s/src.srt',
    } as any,
    existsIn(['/s/shifted.srt', '/s/out.srt', '/s/src.srt']),
    false,
  ),
  '/s/shifted.srt',
  '合成字幕优先级: 顺延版最高',
);
eq(
  pickComposeSubtitle(
    { translatedSrtFile: '/s/out.txt', srtFile: '/s/src.srt' } as any,
    existsIn(['/s/out.txt', '/s/src.srt']),
    false,
  ),
  '/s/src.srt',
  '合成字幕优先级: txt 跳过取源字幕',
);

// ── deriveComposeConfig ─────────────────────────────────────────────────────

{
  const derived = deriveComposeConfig({
    file: {
      filePath: '/v/ep1.mp4',
      fileExtension: '.mp4',
      dubbedTrackPath: '/sess/dub-track.wav',
      shiftedSubtitlePath: '/sess/dubbed-shifted.srt',
      translatedSrtFile: '/v/ep1.zh.srt',
      srtFile: '/v/ep1.srt',
    } as any,
    compose: { subtitle: 'hard' },
    style: STYLE,
    videoQuality: 'original',
    encoderMode: 'cpu',
    exists: existsIn([
      '/sess/dub-track.wav',
      '/sess/dubbed-shifted.srt',
      '/v/ep1.zh.srt',
      '/v/ep1.srt',
    ]),
  });
  eq(derived.ok, true, '矩阵推导: 配音成片可行');
  if (derived.ok) {
    eq(
      derived.config.audio,
      { mode: 'replace', trackPath: '/sess/dub-track.wav' },
      '矩阵推导: 有配音轨 → 替换音轨',
    );
    eq(
      (derived.config.subtitle as any).subtitlePath,
      '/sess/dubbed-shifted.srt',
      '矩阵推导: 硬烧顺延字幕优先',
    );
    eq(
      derived.config.outputPath,
      '/v/ep1-final.mp4',
      '矩阵推导: 输出 -final 沿用源扩展名',
    );
  }
}

{
  const derived = deriveComposeConfig({
    file: {
      filePath: '/v/ep2.mp4',
      fileExtension: '.mp4',
      translatedSrtFile: '/v/ep2.zh.srt',
    } as any,
    compose: { subtitle: 'soft' },
    style: STYLE,
    exists: existsIn(['/v/ep2.zh.srt']),
  });
  eq(derived.ok, true, '矩阵推导: 无配音软封可行');
  if (derived.ok) {
    eq(derived.config.audio, { mode: 'keep' }, '矩阵推导: 无配音 → 保留原声');
    eq(derived.config.outputPath, '/v/ep2-final.mkv', '矩阵推导: 软封强制 mkv');
  }
}

eq(
  deriveComposeConfig({
    file: { filePath: '/v/ep3.mp4', fileExtension: '.mp4' } as any,
    compose: { subtitle: 'none' },
    style: STYLE,
    exists: existsIn([]),
  }),
  { ok: false, reason: 'none-without-dub' },
  '矩阵推导: none 且无配音 → 配置错误',
);

eq(
  deriveComposeConfig({
    file: { filePath: '/v/ep4.mp4', fileExtension: '.mp4' } as any,
    compose: { subtitle: 'hard' },
    style: STYLE,
    exists: existsIn([]),
  }),
  { ok: false, reason: 'no-subtitle' },
  '矩阵推导: 无可用字幕 → 错误',
);

// ── resolveComposeRunOptions：任务快照 → 合成偏好 → 默认 的三级回退 ─────────

{
  const wizardStyle: SubtitleStyle = {
    ...DEFAULT_PIPELINE_STYLE,
    fontName: 'Georgia',
    fontSize: 28,
    primaryColor: '#FFFFC8',
  };
  const resolved = resolveComposeRunOptions(
    {
      style: wizardStyle,
      videoQuality: 'high',
      encoderMode: 'hardware',
    },
    { videoQuality: 'standard', encoderMode: 'cpu' },
    'darwin',
  );
  eq(
    resolved,
    { style: wizardStyle, videoQuality: 'high', encoderMode: 'hardware' },
    'compose 生效参数: 任务快照优先于合成偏好',
  );
}

eq(
  resolveComposeRunOptions(
    { subtitle: 'hard' } as any,
    { videoQuality: 'standard', encoderMode: 'hardware' },
    'darwin',
  ),
  {
    style: {
      ...DEFAULT_PIPELINE_STYLE,
      fontName: platformDefaultFont('darwin'),
    },
    videoQuality: 'standard',
    encoderMode: 'hardware',
  },
  'compose 生效参数: 快照缺省回退合成偏好 + 平台默认样式',
);

eq(
  resolveComposeRunOptions({ subtitle: 'hard' } as any, undefined, 'win32'),
  {
    style: {
      ...DEFAULT_PIPELINE_STYLE,
      fontName: platformDefaultFont('win32'),
    },
    videoQuality: 'original',
    encoderMode: 'cpu',
  },
  'compose 生效参数: 无偏好回退默认（original/cpu）',
);

{
  // 旧配方/快照样式缺新增字段：与默认浅合并兜底
  const partial = { fontName: 'Impact', fontSize: 30 } as any;
  const resolved = resolveComposeRunOptions(
    { style: partial },
    undefined,
    'linux',
  );
  eq(
    resolved.style,
    { ...DEFAULT_PIPELINE_STYLE, fontName: 'Impact', fontSize: 30 },
    'compose 生效参数: 部分样式与默认浅合并',
  );
}

// ── gateLogic：检查点停靠判定 / 放行过滤 / 幂等 ─────────────────────────────

const GATED = {
  gates: { subtitle: 'manual' as const, dubbing: 'manual' as const },
  dub: {},
  compose: {},
};

eq(
  shouldDockAtSubtitleGate(GATED, {}),
  true,
  'gate: manual+有下游 → 字幕校对停靠',
);
eq(
  shouldDockAtSubtitleGate(GATED, { subtitleGate: 'passed' }),
  false,
  'gate: 已放行不再停靠（续跑穿过）',
);
eq(
  shouldDockAtSubtitleGate(
    { gates: { subtitle: 'manual' } }, // 无 dub/compose
    {},
  ),
  false,
  'gate: 无下游阶段不停靠',
);
eq(
  shouldDockAtSubtitleGate({ gates: { subtitle: 'auto' }, dub: {} }, {}),
  false,
  'gate: auto 不停靠',
);
eq(
  shouldDockAtSubtitleGate(undefined, {}),
  false,
  'gate: 未配置 gates（既有任务）零变化',
);
eq(shouldDockAtDubbingGate(GATED, {}), true, 'gate: 配音确认 manual → 停靠');
eq(
  shouldDockAtDubbingGate(GATED, { dubbingGate: 'passed' }),
  false,
  'gate: 配音确认已放行穿过',
);
eq(
  shouldDockAtDubbingGate({ gates: { dubbing: 'manual' } }, {}),
  false,
  'gate: 无配音阶段时配音确认不生效',
);

{
  const files = [
    { uuid: 'a', subtitleGate: 'review' },
    { uuid: 'b', subtitleGate: 'passed' },
    { uuid: 'c', subtitleGate: 'review', dubbingGate: 'review' },
    { uuid: 'd' },
  ];
  eq(
    filterReleasableFiles(files, 'subtitle').map((f) => f.uuid),
    ['a', 'c'],
    'gate: 放行过滤仅 review 文件（passed/未到闸排除）',
  );
  eq(
    filterReleasableFiles(files, 'subtitle', ['c', 'd']).map((f) => f.uuid),
    ['c'],
    'gate: 按 uuid 圈定子集且仍要求 review',
  );
  eq(
    filterReleasableFiles(files, 'dubbing').map((f) => f.uuid),
    ['c'],
    'gate: 配音确认独立过滤',
  );
  eq(countReviewFiles(files), { subtitle: 2, dubbing: 1 }, 'gate: 待校对计数');
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项断言失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
