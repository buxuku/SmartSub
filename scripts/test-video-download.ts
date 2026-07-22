/// <reference path="./test-globals.d.ts" />
/**
 * 在线视频下载单元测试（openspec: add-video-downloader）。
 *
 * 覆盖：
 * - extractUrls：混杂文本抽取、去重、黏连标点清洗、非法丢弃
 * - routeEngines：域名路由（lux 优先域/默认 yt-dlp）、手动指定、单引擎降级
 * - compareDateVersion：清单版本比较（yt-dlp 日期版式）
 * - parseYtDlpProgressLine / parseYtDlpPreflightJson：进度模板与 -J 元数据
 * - parseLuxProgressChunk / parseLuxPreflightJson：进度文本与 -j 元数据（含降级判定）
 * - isLikelyOutdatedEngineError / tailForError：错误分类与裁剪
 */
import {
  extractUrls,
  routeEngines,
  LUX_PREFERRED_DOMAINS,
} from '../types/download';
import { compareDateVersion } from '../main/helpers/download/versionCompare';
import {
  claimSubtitleFileNames,
  parseYtDlpProgressLine,
  parseYtDlpPreflightJson,
  parseLuxProgressChunk,
  parseLuxPreflightJson,
  isLikelyOutdatedEngineError,
  isLuxPartFileName,
  tailForError,
  YTDLP_PROGRESS_TEMPLATE,
} from '../main/helpers/videoDownload/parsers';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function ok(condition: boolean, name: string): void {
  eq(condition, true, name);
}

function run(): void {
  // ==========================================================
  // extractUrls（spec: 下载页与批量链接输入）
  // ==========================================================
  eq(
    extractUrls(
      '看这个 https://www.youtube.com/watch?v=abc123 超好笑\nhttps://b23.tv/xyz。\nhttps://www.youtube.com/watch?v=abc123',
    ),
    ['https://www.youtube.com/watch?v=abc123', 'https://b23.tv/xyz'],
    'extractUrls: 混杂文本抽取 + 去重 + 末尾中文句号清洗',
  );
  eq(extractUrls(''), [], 'extractUrls: 空文本');
  eq(extractUrls('没有链接的一段话 http://'), [], 'extractUrls: 非法 URL 丢弃');
  eq(
    extractUrls('(https://example.com/v/1), [https://example.com/v/2]'),
    ['https://example.com/v/1', 'https://example.com/v/2'],
    'extractUrls: 一行多链接 + 括号/逗号黏连清洗',
  );
  eq(
    extractUrls('ftp://example.com/file 与 https://ok.com/v'),
    ['https://ok.com/v'],
    'extractUrls: 仅取 http(s)',
  );

  // ==========================================================
  // routeEngines（spec: 引擎路由与失败回退）
  // ==========================================================
  const BOTH: Array<'yt-dlp' | 'lux'> = ['yt-dlp', 'lux'];
  eq(
    routeEngines('https://www.bilibili.com/video/BV1', 'auto', BOTH),
    ['yt-dlp', 'lux'],
    'routeEngines: bilibili → yt-dlp 优先（匿名 1080P vs lux 480P）',
  );
  eq(
    routeEngines('https://b23.tv/abc', 'auto', BOTH),
    ['yt-dlp', 'lux'],
    'routeEngines: b23.tv 短链同 bilibili 走 yt-dlp',
  );
  eq(
    routeEngines('https://www.youtube.com/watch?v=1', 'auto', BOTH),
    ['yt-dlp', 'lux'],
    'routeEngines: 未命中域 → yt-dlp 优先',
  );
  eq(
    routeEngines('https://v.douyin.com/x/', 'auto', BOTH),
    ['lux', 'yt-dlp'],
    'routeEngines: douyin 子域匹配',
  );
  eq(
    routeEngines('https://v.douyin.com/x/', 'auto', ['yt-dlp']),
    ['yt-dlp'],
    'routeEngines: 单引擎降级（lux 未装时 lux 优先域也走 yt-dlp）',
  );
  eq(
    routeEngines('https://www.youtube.com/watch?v=1', 'lux', BOTH),
    ['lux'],
    'routeEngines: 手动指定跳过路由与回退',
  );
  eq(
    routeEngines('https://www.youtube.com/watch?v=1', 'lux', ['yt-dlp']),
    [],
    'routeEngines: 手动指定但未安装 → 空',
  );
  eq(
    routeEngines('not-a-url', 'auto', BOTH),
    ['yt-dlp', 'lux'],
    'routeEngines: 非法 URL 走默认序',
  );
  ok(
    LUX_PREFERRED_DOMAINS.includes('xiaohongshu.com'),
    'routeEngines: 路由表含小红书',
  );

  // ==========================================================
  // compareDateVersion（spec: 下载器应用内更新）
  // ==========================================================
  ok(
    compareDateVersion('2026.07.04', '2026.06.09') > 0,
    'versionCompare: 新版本大于旧版本',
  );
  ok(
    compareDateVersion('2026-07-04', '2026.07.04') === 0,
    'versionCompare: 分隔符归一化相等',
  );

  // ==========================================================
  // yt-dlp 进度模板解析
  // ==========================================================
  ok(
    YTDLP_PROGRESS_TEMPLATE.startsWith('SMARTSUB-DL;'),
    'ytdlp: 模板携带机器可读前缀',
  );
  eq(
    parseYtDlpProgressLine('SMARTSUB-DL;  12.3%; 3.21MiB/s;00:41'),
    { progress: 12.3, speed: '3.21MiB/s', eta: '00:41' },
    'ytdlp: 进度行解析（百分比/速度/ETA）',
  );
  eq(
    parseYtDlpProgressLine('SMARTSUB-DL; 100.0%;Unknown;Unknown'),
    { progress: 100 },
    'ytdlp: Unknown 速度/ETA 不透传',
  );
  eq(
    parseYtDlpProgressLine('[download] Destination: foo.mp4'),
    null,
    'ytdlp: 非进度行返回 null',
  );

  // ==========================================================
  // yt-dlp -J 预检解析
  // ==========================================================
  eq(
    parseYtDlpPreflightJson(
      JSON.stringify({
        title: 'Test Video',
        duration: 213.5,
        thumbnail: 'https://i.ytimg.com/t.jpg',
        formats: [
          { height: 720 },
          { height: 1080 },
          { height: null },
          { height: 1080 },
        ],
      }),
    ),
    {
      title: 'Test Video',
      duration: 213.5,
      thumbnail: 'https://i.ytimg.com/t.jpg',
      heights: [1080, 720],
    },
    'ytdlp preflight: 单视频（标题/时长/清晰度去重降序）',
  );
  eq(
    parseYtDlpPreflightJson(
      JSON.stringify({
        _type: 'playlist',
        title: 'My List',
        entries: [
          { url: 'https://youtu.be/1', title: 'ep1' },
          { url: 'https://youtu.be/2' },
          { title: 'no-url-entry' },
        ],
      }),
    ),
    {
      title: 'My List',
      playlistCount: 3,
      playlistItems: [
        { url: 'https://youtu.be/1', title: 'ep1' },
        { url: 'https://youtu.be/2' },
      ],
    },
    'ytdlp preflight: 播放列表（条目数 + 有效条目提取）',
  );

  // ==========================================================
  // yt-dlp 预检官方字幕（spec: 下载前预检 - 官方字幕徽章标注）
  // ==========================================================
  eq(
    parseYtDlpPreflightJson(
      JSON.stringify({
        title: 'Subbed',
        subtitles: { 'zh-Hans': [{}], en: [{}], live_chat: [{}] },
        automatic_captions: { ja: [{}], ko: [{}] },
      }),
    ),
    { title: 'Subbed', subtitleLangs: ['en', 'zh-Hans'] },
    'ytdlp preflight: 官方字幕语言排序 + live_chat 剔除 + 自动字幕无视',
  );
  eq(
    parseYtDlpPreflightJson(
      JSON.stringify({
        title: 'AutoOnly',
        subtitles: {},
        automatic_captions: { en: [{}] },
      }),
    ),
    { title: 'AutoOnly' },
    'ytdlp preflight: 仅自动字幕 → 无 subtitleLangs',
  );
  eq(
    parseYtDlpPreflightJson(
      JSON.stringify({ title: 'LiveOnly', subtitles: { live_chat: [{}] } }),
    ),
    { title: 'LiveOnly' },
    'ytdlp preflight: 仅 live_chat → 无 subtitleLangs',
  );

  // ==========================================================
  // 字幕文件认领（spec: 源站字幕直取 - 按视频主干认领）
  // ==========================================================
  const dirListing = [
    'Foo Video [abc123].mp4',
    'Foo Video [abc123].en.srt',
    'Foo Video [abc123].zh-Hans.vtt',
    'Foo Video [abc123].live_chat.json',
    'Foo Video [abc123].srt.part',
    'Bar Video [xyz789].en.srt',
    'Foo Video [abc123] another.en.srt',
    '全世界笑点[0].mp4',
  ];
  eq(
    claimSubtitleFileNames('Foo Video [abc123].mp4', dirListing),
    ['Foo Video [abc123].en.srt', 'Foo Video [abc123].zh-Hans.vtt'],
    'claimSubs: 同主干多语言认领（srt/vtt）+ 无关文件/json/part 排除 + 排序确定',
  );
  eq(
    claimSubtitleFileNames('Foo Video [abc123].mp4', [
      'Foo Video [abc123].srt',
    ]),
    [],
    'claimSubs: 裸 `主干.srt`（无语言中缀）不认领',
  );
  eq(
    claimSubtitleFileNames('Ep 1 [id1].mp4', ['Ep 1.5 [id2].en.srt']),
    [],
    'claimSubs: 相近主干不误认领（[id] 唯一性）',
  );
  eq(
    claimSubtitleFileNames('demo.mkv', ['demo.en.ASS', 'demo.en.ssa']),
    ['demo.en.ASS'],
    'claimSubs: 扩展名大小写不敏感 + ssa 不在白名单',
  );
  eq(claimSubtitleFileNames('.mp4', ['.en.srt']), [], 'claimSubs: 空主干防御');

  // ==========================================================
  // lux 解析
  // ==========================================================
  eq(
    parseLuxProgressChunk(
      ' 1.10 MiB / 720.00 MiB [>--------------] 0.15% 3.20 MiB/s 00m41s',
    ),
    { progress: 0.15, speed: '3.20MiB/s' },
    'lux: 进度条文本解析',
  );
  eq(
    parseLuxProgressChunk('Downloading segment 3...'),
    null,
    'lux: 无百分比文本返回 null（触发文件大小轮询降级）',
  );
  eq(
    parseLuxProgressChunk('10.0% ... 55.5%'),
    { progress: 55.5 },
    'lux: 多个百分比取最后一个',
  );
  eq(
    parseLuxPreflightJson(
      JSON.stringify([
        {
          title: 'B站视频',
          streams: {
            '80': { parts: [{ size: 1000 }, { size: 2000 }] },
            '32': { size: 500 },
          },
        },
      ]),
    ),
    { title: 'B站视频', totalBytes: 3000 },
    'lux preflight: 标题 + 最大流体积（parts 求和）',
  );
  eq(
    parseLuxPreflightJson(JSON.stringify([{ title: 'a' }, { title: 'b' }])),
    { title: 'a', playlistCount: 2 },
    'lux preflight: 多条目 → playlistCount',
  );

  // ==========================================================
  // lux 分片文件名判定（合并前中间产物不可认领为成品）
  // ==========================================================
  ok(
    isLuxPartFileName('全世界笑点[0].mp4', '全世界笑点'),
    'luxPart: baseName + [0] 视频分片',
  );
  ok(
    isLuxPartFileName('全世界笑点[1].m4a', '全世界笑点'),
    'luxPart: baseName + [1] 音频分片',
  );
  ok(
    !isLuxPartFileName('全世界笑点.mp4', '全世界笑点'),
    'luxPart: 合并后成品不是分片',
  );
  ok(
    !isLuxPartFileName('别的视频[0].mp4', '全世界笑点'),
    'luxPart: baseName 不匹配不认领',
  );
  ok(isLuxPartFileName('某标题[0].mp4'), 'luxPart: 无 baseName 时启发式命中');
  ok(
    !isLuxPartFileName('Big Buck Bunny [BigBuckBunny_124].avi'),
    'luxPart: yt-dlp 的字母 id 后缀不误判',
  );
  ok(
    !isLuxPartFileName('年度回顾 [2024].mp4'),
    'luxPart: 3 位以上数字后缀不误判（标题年份）',
  );

  // ==========================================================
  // 错误分类与裁剪
  // ==========================================================
  ok(
    isLikelyOutdatedEngineError(
      'ERROR: Unsupported URL: https://example.com/x',
    ),
    'error: Unsupported URL → 疑似过旧',
  );
  ok(
    isLikelyOutdatedEngineError('Unable to extract player version'),
    'error: Unable to extract → 疑似过旧',
  );
  ok(
    !isLikelyOutdatedEngineError('HTTP Error 403: Forbidden'),
    'error: 403 不判为过旧',
  );
  eq(
    tailForError('line1\nERROR: bad thing happened\nline3\n'),
    'ERROR: bad thing happened',
    'error: 优先提取 ERROR 行',
  );
  eq(tailForError('a\nb\nc\nd'), 'b | c | d', 'error: 无 ERROR 行时取末尾行');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
