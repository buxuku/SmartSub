/**
 * 把 ffmpeg 的失败输出（stderr）归纳成「真正的失败原因」（issue #521）。
 *
 * 背景：fluent-ffmpeg 拼 err.message 时（utils.extractError）遇到以 `[` 或空格开头的行就会清空
 * 已收集的内容，而 ffmpeg 6 的原因行恰好都带 `[xxx @ 0x…]` 前缀，于是用户只看到
 * "Conversion failed!"，有时甚至是空的 "exited with code 1: "。完整的 stderr 其实作为 error
 * 回调的第 3 个参数传了出来，这里负责从中取因。
 *
 * 与 ffmpegErrorUtils（#370）的关系：那边服务音频提取，把最后一行补进空消息并映射几类固定文案。
 * 合成作业的失败往往是一串连环报错——根因在最上面，下面跟着 "Error initializing output stream"
 * 之类的后果行，再往后还有 aac 的 Qavg 之类的信息行——所以这里取的是「失败簇」，不是最后一行。
 *
 * 纯逻辑，不依赖 Electron。
 */

/**
 * 最后一条关键词行之后最多还能跟这么多条有效行。失败原因紧贴输出结尾（后面至多是几行收尾信息），
 * 之后还有大段输出的关键词行是更早的、与这次失败无关的告警。
 */
const MAX_LINES_AFTER_REASON = 20;
/** 失败簇最多展示的行数（保留最后几行）。 */
const MAX_REASON_LINES = 8;
/** 找不到明确的原因行时，回退展示的末尾行数。 */
const FALLBACK_LINES = 4;
/** 单行最大长度，防止界面被超长行撑开。 */
const MAX_LINE_LENGTH = 400;

/** `[libx264 @ 0x108706550]`（Windows 上是不带 0x 的 `@ 000001F2…`）里的对象地址，每次运行都不同。 */
const OBJECT_ADDRESS = / @ (?:0x)?[0-9a-f]{6,}(?=\])/gi;

/** 带这些词的行才可能是失败原因（均为正则片段，忽略大小写，前面要求词边界）。 */
const DIAGNOSTIC_PHRASES = [
  // ffmpeg 与各个库自己的措辞
  'error',
  'fail',
  'invalid',
  'unsupported',
  'unable',
  'unknown',
  'unrecognized',
  'corrupt',
  'incorrect',
  'cannot',
  "can't",
  'could not',
  "couldn't",
  'not (?:supported|found|divisible)',
  'supported for',
  // strerror() 的文案：`av_interleaved_write_frame(): Broken pipe`、`<path>: Permission denied`
  'denied',
  'no such',
  'no space',
  'broken pipe',
  'read-only file system',
  'input/output error',
  'operation not permitted',
  '(?:is|not) a directory',
  'file exists',
  'too many open files',
  'disk quota',
  'bad file descriptor',
  'connection (?:refused|reset|timed out)',
];
const DIAGNOSTIC = new RegExp(
  // `av_xxx(): …` 是 ffmpeg 报告函数失败的固定格式
  `\\b(?:${DIAGNOSTIC_PHRASES.join('|')})|\\bav_\\w+\\(\\):`,
  'i',
);

/**
 * 与失败原因无关的输出，一律忽略：包装行、版本横幅、结构标题、进度、失败之后编码器的收尾信息，
 * 以及反复刷屏的良性告警。
 *
 * 其中带 error/fail/not found 字样的必须明确排除，否则会被当成原因，还会把真正的失败簇隔断：
 * Conversion failed!、Task finished with error code…，以及字幕里有 emoji/缺字形时 libass 每帧都打印的
 * `Glyph 0x… not found`、`fontselect: failed to find…`、`Error opening font:`（真实输出里能占满最后 100 行）。
 */
const NOISE: readonly RegExp[] = [
  /^conversion failed!?$/i,
  /\btask finished with error code\b/i,
  /\bterminating thread with return code\b/i,
  /^ffmpeg version\b/i,
  /^built with\b/i,
  /^configuration:/i,
  /^lib[a-z]+\s+\d+\./i,
  /^(?:input|output) #\d+,/i,
  /^stream mapping:/i,
  /^press \[q\]/i,
  /^guessed channel layout\b/i,
  /^fontconfig\b/i,
  /\bfontselect:/i,
  /\bglyph 0x[0-9a-f]+ not found\b/i,
  /\berror opening font:/i,
  // macOS 系统库写进 stderr 的 NSLog，如 `2026-10-09 15:39:15.962 ffmpeg[57648:7793868] CoreText note: …`
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \S+\[\d+:\d+\]/,
  /^(?:frame|size|lsize)\s*=/i,
  /\bvideo:\d+\w*\s+audio:\d/i,
  /\bqavg:/i,
  /\bframes? left in the queue on closing\b/i,
  /^last message repeated\b/i,
];

/**
 * 只汇报状态的组件：x264/x265 的初始化与收尾统计（十几行）、libass 的版本与字体提供者信息。
 * 它们的非关键词行永远不是原因，直接忽略，免得挤占「紧贴末尾」的判断；带关键词的
 * （`[libx264] width not divisible by 2`、`[Parsed_ass_0] fopen failed`）仍是原因。
 */
const STATUS_ONLY_SOURCES = /^\[(?:libx26[45]|Parsed_\w+)\]/;

interface FailureLine {
  text: string;
  diagnostic: boolean;
}

/**
 * 解析 stderr：去掉对象地址与首尾空白，丢弃空行、缩进行与噪声行。
 *
 * 缩进行是 ffmpeg 的结构化信息（输入元数据、Stream 列表、横幅里的库版本），
 * 失败原因从不缩进；视频标题里恰好带 "Error" 之类的词时，不能被误认成原因。
 */
function parseFailureLines(stderr: string): FailureLine[] {
  const lines: FailureLine[] = [];
  for (const raw of stderr.split(/\r\n|\r|\n/)) {
    if (/^\s/.test(raw)) continue;
    const text = raw.replace(OBJECT_ADDRESS, '').trim();
    if (!text || NOISE.some((pattern) => pattern.test(text))) continue;
    const diagnostic = DIAGNOSTIC.test(text);
    if (!diagnostic && STATUS_ONLY_SOURCES.test(text)) continue;
    lines.push({ text, diagnostic });
  }
  return lines;
}

function clamp(text: string): string {
  return text.length > MAX_LINE_LENGTH
    ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…`
    : text;
}

/**
 * 取出失败原因（多行以 \n 连接）。没有任何可用内容时返回 ''。
 *
 * 1. 找最后一条带失败关键词的行，再向上收集与它连续的关键词行，构成「失败簇」；
 *    它之后若还跟着超过 {@link MAX_LINES_AFTER_REASON} 条有效行，说明它与这次失败无关；
 * 2. 没有（可信的）关键词行，如 "Output file does not contain any stream"，就回退展示末尾几行。
 */
export function summarizeFfmpegFailure(stderr?: string | null): string {
  if (!stderr) return '';
  const lines = parseFailureLines(stderr);

  let end = lines.length - 1;
  while (end >= 0 && !lines[end].diagnostic) end--;

  let picked: FailureLine[];
  if (end < 0 || lines.length - 1 - end > MAX_LINES_AFTER_REASON) {
    picked = lines.slice(-FALLBACK_LINES);
  } else {
    let start = end;
    while (start > 0 && lines[start - 1].diagnostic) start--;
    picked = lines.slice(start, end + 1);
  }

  const reason: string[] = [];
  for (const { text } of picked) {
    if (reason[reason.length - 1] !== text) reason.push(text);
  }
  return reason.slice(-MAX_REASON_LINES).map(clamp).join('\n');
}

/** fluent-ffmpeg 在进程以非零退出码结束时给出的错误：`ffmpeg exited with code 1: …`。 */
const EXIT_ERROR = /^ffmpeg exited with code (-?\d+)/;

/**
 * 让 "ffmpeg exited with code N" 错误带上真实原因：消息改写为
 * `ffmpeg exited with code N: <原因>`，原错误挂在 cause 上。
 *
 * 其它错误（被信号杀死、启动失败、用户取消）以及取不到原因时，原样返回同一个错误对象。
 */
export function withFfmpegFailureReason(
  error: Error,
  stderr?: string | null,
): Error {
  const exit = EXIT_ERROR.exec(error?.message ?? '');
  if (!exit) return error;
  const reason = summarizeFfmpegFailure(stderr);
  if (!reason) return error;
  return new Error(`ffmpeg exited with code ${exit[1]}: ${reason}`, {
    cause: error,
  });
}
