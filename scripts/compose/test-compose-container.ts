import assert from 'node:assert/strict';
import {
  assertComposeOutputWritable,
  isComposeContainerWritable,
  sourceAudioNeedsAac,
  writableComposeExtension,
} from '../../types/composeContainer';

/**
 * #521：合成引擎的每种成片形态都写 H.264（硬烧重编码）或 AAC（配音换轨/混音），
 * 而 WebM/Ogg muxer 只接受 VP8/VP9/AV1 + Vorbis/Opus（ffmpeg 6.0 实测）。
 * 容器可写性是主进程（队列、命令构建、默认路径）与渲染层共用的纯函数。
 */

// ── isComposeContainerWritable：黑名单只含已验证会拒绝 H.264 的容器 ────────────

for (const extension of ['.webm', '.WEBM', '.WebM', '.ogv', '.ogg', '.OGG']) {
  assert.equal(
    isComposeContainerWritable(extension),
    false,
    `${extension} cannot hold H.264/AAC`,
  );
}
for (const extension of [
  '.mp4',
  '.MP4',
  '.mkv',
  '.mov',
  '.m4v',
  '.avi',
  '.flv',
  '.ts',
  '.mts',
  '.m2ts',
  '.3gp',
  '.wmv',
  '.asf',
  '.vob',
  '.rm',
  '.rmvb',
  '',
]) {
  assert.equal(
    isComposeContainerWritable(extension),
    true,
    `${extension || '(none)'} keeps its existing behaviour`,
  );
}
// 调用方可能直接传不带点的写法
assert.equal(isComposeContainerWritable('webm'), false);
assert.equal(isComposeContainerWritable('mp4'), true);

// ── writableComposeExtension：可写的原样返回（保留大小写），其余回落 .mp4 ─────

for (const [input, expected] of [
  ['.webm', '.mp4'],
  ['.WEBM', '.mp4'],
  ['.ogv', '.mp4'],
  ['.ogg', '.mp4'],
  ['.mp4', '.mp4'],
  ['.MP4', '.MP4'],
  ['.mkv', '.mkv'],
  ['.MKV', '.MKV'],
  ['.mov', '.mov'],
  ['.avi', '.avi'],
  ['', ''],
] as const) {
  assert.equal(
    writableComposeExtension(input),
    expected,
    `${input || '(none)'} -> ${expected || '(none)'}`,
  );
}

// ── assertComposeOutputWritable：引擎入口的拒绝，错误信息给出可操作的修复办法 ──

for (const rejected of [
  '/v/clip_subtitled.webm',
  'C:\\Videos\\SmartSub\\clip_subtitled.webm',
  '/v/CLIP.WEBM',
  '/v/a.ogv',
  '/v/a.ogg',
]) {
  assert.throws(
    () => assertComposeOutputWritable(rejected),
    (error: unknown) =>
      error instanceof Error &&
      /WebM\/Ogg/.test(error.message) &&
      /\.mp4/.test(error.message) &&
      /\.mkv/.test(error.message),
    `${rejected} must be rejected with guidance`,
  );
}
assert.throws(
  () => assertComposeOutputWritable('/v/clip_subtitled.webm'),
  /"\.webm"/,
  'the message names the offending extension',
);
for (const accepted of [
  '/v/out.mp4',
  '/v/out.mkv',
  '/v/out.MOV',
  '/v/no-extension',
  // 只看最后一段文件名：目录名里的 .webm 不是容器
  'C:\\a.webm\\out.mp4',
  '/v/dir.webm/out.mkv',
  '/v/dir.webm/no-extension',
]) {
  assert.doesNotThrow(
    () => assertComposeOutputWritable(accepted),
    `${accepted} is writable`,
  );
}

// ── sourceAudioNeedsAac：仅 WebM/Ogg 源 → MP4 系输出时，音频才需转 AAC ────────

for (const [source, output, expected] of [
  ['.webm', '.mp4', true],
  ['.WEBM', '.MP4', true],
  ['.webm', '.mov', true],
  ['.webm', '.m4v', true],
  ['.ogv', '.mp4', true],
  ['.ogg', '.mp4', true],
  // 用户手动选 .mkv：Matroska 接受 Opus/Vorbis，保持直拷
  ['.webm', '.mkv', false],
  // 其余组合保持既有的 -c:a copy
  ['.mp4', '.mp4', false],
  ['.mkv', '.mp4', false],
  ['.mov', '.mp4', false],
  ['.avi', '.mp4', false],
  ['.mp4', '.mkv', false],
  ['', '.mp4', false],
] as const) {
  assert.equal(
    sourceAudioNeedsAac(source, output),
    expected,
    `${source || '(none)'} -> ${output}: AAC=${expected}`,
  );
}

console.log(
  JSON.stringify({
    checks:
      'writable-container table (webm/ogv/ogg denied, case-insensitive, others untouched), .mp4 fallback preserving case, engine-entry rejection message with remediation, directory names ignored, WebM/Ogg-to-MP4-family AAC rule',
  }),
);
