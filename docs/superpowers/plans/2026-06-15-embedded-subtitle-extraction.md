# 内嵌软字幕直提 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 视频转字幕时自动探测内封文本软字幕，命中则用内置 ffmpeg 直接抽取为 SRT，跳过抽音频 + ASR，否则回退现有流程。

**Architecture:** 复用现有任务节点 `extractAudio`（提取）与 `extractSubtitle`（听写），状态机零改动。纯解析逻辑拆入独立可单测模块；IO（探测/抽取）放入 `audioProcessor.ts` 复用其 ffmpeg 路径与取消机制；在 `fileProcessor.ts` 生成分支插入"先探测、命中即抽取、失败回退 ASR"逻辑。下游零改动。

**Tech Stack:** Electron 主进程 (TypeScript) · 内置 `ffmpeg-static` 二进制 · `fluent-ffmpeg` · `child_process.spawn` · 现有 `scripts/test-engine-units.ts` 纯逻辑单测框架。

参考设计：`docs/superpowers/specs/2026-06-15-embedded-subtitle-extraction-design.md`

---

## File Structure

| 文件                                             | 职责                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main/helpers/embeddedSubtitleParser.ts`（新建） | 纯逻辑：容器扩展名预过滤、ffmpeg stderr 字幕流解析、SRT 含 cue 判定。零 ffmpeg/electron 依赖，可单测。                                           |
| `main/helpers/audioProcessor.ts`（修改）         | 新增 `probeEmbeddedSubtitles`（spawn 探测）与 `extractEmbeddedSubtitle`（fluent-ffmpeg 抽取），复用 `ffmpegPath` 与 `runningCommands` 取消机制。 |
| `main/helpers/fileProcessor.ts`（修改）          | 在生成分支插入内封探测/抽取 + 空字幕兜底 + 回退 ASR。                                                                                            |
| `scripts/test-engine-units.ts`（修改）           | 追加解析器单测用例。                                                                                                                             |

**Out of scope（不在本计划内）：** 移除无引用的死依赖 `@ffmpeg-installer/ffmpeg`（独立清理项）；逐文件选轨 UI；图形字幕 OCR；按源语言匹配字幕轨。

**Gates（每个代码任务结束都要过）：**

- 类型检查：`npx tsc -p tsconfig.json`（期望无输出、退出码 0）
- 单测：`npm run test:engines`（期望末行 `... 0 failed`）

---

## Task 1: 纯解析模块 `embeddedSubtitleParser.ts`（TDD）

**Files:**

- Create: `main/helpers/embeddedSubtitleParser.ts`
- Test: `scripts/test-engine-units.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `scripts/test-engine-units.ts` 顶部 import 区（现有 `import { MirrorDownloader } ...` 之后）追加：

```ts
import {
  canHaveEmbeddedSubtitle,
  parseSubtitleStreams,
  srtHasCues,
} from '../main/helpers/embeddedSubtitleParser';
```

在文件末尾的 `console.log(\`\nengine unit tests: ...\`)` 这一行**之前**追加：

```ts
// --- embedded subtitle: parseSubtitleStreams ---
const MKV_MIXED = [
  "Input #0, matroska,webm, from 'movie.mkv':",
  '  Duration: 01:23:45.00, start: 0.000000, bitrate: 4500 kb/s',
  '    Stream #0:0(eng): Video: h264 (High), yuv420p, 1920x1080, 23.98 fps',
  '    Stream #0:1(eng): Audio: aac, 48000 Hz, stereo, fltp',
  '    Stream #0:2(eng): Subtitle: hdmv_pgs_subtitle (default)',
  '    Stream #0:3(chi): Subtitle: subrip',
  '    Stream #0:4(jpn): Subtitle: ass (forced)',
].join('\n');
eq(
  parseSubtitleStreams(MKV_MIXED),
  [
    {
      subIndex: 0,
      codec: 'hdmv_pgs_subtitle',
      language: 'eng',
      isText: false,
      isDefault: true,
      isForced: false,
    },
    {
      subIndex: 1,
      codec: 'subrip',
      language: 'chi',
      isText: true,
      isDefault: false,
      isForced: false,
    },
    {
      subIndex: 2,
      codec: 'ass',
      language: 'jpn',
      isText: true,
      isDefault: false,
      isForced: true,
    },
  ],
  'embed: mkv mixed image+text tracks',
);

const MP4_MOVTEXT = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '    Stream #0:0(und): Video: h264, yuv420p, 1280x720',
  '    Stream #0:1(und): Audio: aac, 44100 Hz, stereo',
  '    Stream #0:2(und): Subtitle: mov_text (default)',
].join('\n');
eq(
  parseSubtitleStreams(MP4_MOVTEXT),
  [
    {
      subIndex: 0,
      codec: 'mov_text',
      isText: true,
      isDefault: true,
      isForced: false,
    },
  ],
  'embed: mp4 mov_text, und language omitted',
);

eq(
  parseSubtitleStreams(
    '    Stream #0:2[0x21](eng): Subtitle: subrip (default)',
  ),
  [
    {
      subIndex: 0,
      codec: 'subrip',
      language: 'eng',
      isText: true,
      isDefault: true,
      isForced: false,
    },
  ],
  'embed: stream with hex id',
);

const AUDIO_ONLY = [
  "Input #0, mp3, from 'a.mp3':",
  '    Stream #0:0: Audio: mp3, 16000 Hz, mono, fltp, 64 kb/s',
].join('\n');
eq(
  parseSubtitleStreams(AUDIO_ONLY),
  [],
  'embed: audio only -> no subtitle streams',
);

// --- embedded subtitle: canHaveEmbeddedSubtitle ---
eq(canHaveEmbeddedSubtitle('.mkv'), true, 'embed: .mkv allowed');
eq(canHaveEmbeddedSubtitle('mkv'), true, 'embed: mkv allowed (no dot)');
eq(canHaveEmbeddedSubtitle('.MP4'), true, 'embed: .MP4 case-insensitive');
eq(canHaveEmbeddedSubtitle('.mp3'), false, 'embed: .mp3 audio skipped');
eq(canHaveEmbeddedSubtitle('.avi'), false, 'embed: .avi skipped');
eq(canHaveEmbeddedSubtitle(''), false, 'embed: empty ext skipped');

// --- embedded subtitle: srtHasCues ---
eq(
  srtHasCues('1\n00:00:01,000 --> 00:00:03,000\nHello\n'),
  true,
  'embed: srt with cue',
);
eq(srtHasCues(''), false, 'embed: empty srt no cue');
eq(srtHasCues('   \n  \n'), false, 'embed: whitespace srt no cue');
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run test:engines`
Expected: 编译失败，报错找不到模块 `../main/helpers/embeddedSubtitleParser`（`Cannot find module`）。

- [ ] **Step 3: 写实现**

创建 `main/helpers/embeddedSubtitleParser.ts`：

```ts
/**
 * 内封软字幕：纯解析逻辑（无 ffmpeg / 无 electron 依赖，便于单测）。
 * 仅负责：容器扩展名预过滤、ffmpeg stderr 字幕流解析、SRT 是否含字幕块判定。
 */

export interface EmbeddedSubtitleStream {
  /** 字幕流相对序号（第几条 Subtitle 行，从 0 起），用于 ffmpeg -map 0:s:N */
  subIndex: number;
  /** 小写编码名，如 subrip / ass / mov_text / hdmv_pgs_subtitle */
  codec: string;
  /** 语言标签（如 eng / chi）；缺失或 und 时为 undefined */
  language?: string;
  /** 是否为可直接转 SRT 的文本字幕 */
  isText: boolean;
  isDefault: boolean;
  isForced: boolean;
}

/** 可能内封文本软字幕的容器扩展名（不含点、小写） */
export const EMBEDDED_SUBTITLE_CONTAINERS = new Set([
  'mkv',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'ts',
  'm2ts',
  'mts',
  'ogm',
  'ogv',
]);

/** 可直接 -c:s srt 转写的文本字幕编码 */
export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
]);

/** 扩展名预过滤：仅对可能内封字幕的容器才值得 spawn 探测 */
export function canHaveEmbeddedSubtitle(ext: string): boolean {
  if (!ext) return false;
  return EMBEDDED_SUBTITLE_CONTAINERS.has(ext.replace(/^\./, '').toLowerCase());
}

const SUBTITLE_LINE =
  /Stream #\d+:(\d+)(?:\[0x[0-9a-fA-F]+\])?(?:\(([^)]*)\))?:\s*Subtitle:\s*([A-Za-z0-9_]+)/;

/** 解析 `ffmpeg -i` 的 stderr，按出现顺序返回所有字幕流信息 */
export function parseSubtitleStreams(stderr: string): EmbeddedSubtitleStream[] {
  const streams: EmbeddedSubtitleStream[] = [];
  const lines = (stderr || '').split(/\r?\n/);
  let subIndex = 0;
  for (const line of lines) {
    const m = line.match(SUBTITLE_LINE);
    if (!m) continue;
    const lang = m[2];
    const codec = m[3].toLowerCase();
    streams.push({
      subIndex,
      codec,
      language: lang && lang !== 'und' ? lang : undefined,
      isText: TEXT_SUBTITLE_CODECS.has(codec),
      isDefault: /\(default\)/.test(line),
      isForced: /\(forced\)/.test(line),
    });
    subIndex++;
  }
  return streams;
}

/** SRT 是否至少含一条字幕块（用时间码箭头判定，空/全空白为 false） */
export function srtHasCues(content: string): boolean {
  if (!content) return false;
  return /-->/.test(content);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run test:engines`
Expected: 末行形如 `engine unit tests: NN passed, 0 failed`，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add main/helpers/embeddedSubtitleParser.ts scripts/test-engine-units.ts
git commit -m "feat(subtitle): add embedded subtitle parser (ffmpeg stderr) with unit tests"
```

---

## Task 2: 探测/抽取 IO（`audioProcessor.ts`）

> IO 函数依赖内置 ffmpeg 二进制与 electron 运行时，不纳入纯逻辑单测；本任务以类型检查为门禁，端到端在 Task 4 手测。

**Files:**

- Modify: `main/helpers/audioProcessor.ts`（追加 import + 两个函数）

- [ ] **Step 1: 追加 import**

在 `audioProcessor.ts` 顶部 import 区，`import { getTaskContext, TaskCancelledError } from './taskContext';` 之后追加：

```ts
import { spawn } from 'child_process';
import {
  parseSubtitleStreams,
  EmbeddedSubtitleStream,
} from './embeddedSubtitleParser';
```

- [ ] **Step 2: 追加探测与抽取函数**

在 `audioProcessor.ts` 文件**末尾**追加：

```ts
/**
 * 探测视频内封字幕流：spawn 内置 ffmpeg `-i` 解析 stderr，永不 reject。
 * ffmpeg 因无输出文件以非零码退出属正常，照常解析 stderr。带超时保护。
 */
export function probeEmbeddedSubtitles(
  videoPath: string,
  timeoutMs = 15000,
): Promise<EmbeddedSubtitleStream[]> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (result: EmbeddedSubtitleStream[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath]);
    } catch (err) {
      logMessage(`probe embedded subtitle spawn failed: ${err}`, 'warning');
      resolve([]);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      logMessage(`probe embedded subtitle timeout: ${videoPath}`, 'warning');
      done([]);
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      logMessage(`probe embedded subtitle error: ${err}`, 'warning');
      done([]);
    });
    child.on('close', () => {
      try {
        done(parseSubtitleStreams(stderr));
      } catch (err) {
        logMessage(`parse subtitle streams failed: ${err}`, 'warning');
        done([]);
      }
    });
  });
}

/**
 * 抽取指定内封字幕轨为 SRT（-map 0:s:N -c:s srt）。复用 runningCommands 支持取消；
 * 进度归属「提取」节点（extractAudio）。失败/取消时清理半成品。
 */
export const extractEmbeddedSubtitle = (
  videoPath: string,
  subIndex: number,
  outPath: string,
  event = null,
  file = null,
): Promise<void> => {
  const onProgress = (percent = 0) => {
    const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
    if (event && file) {
      event.sender.send(
        'taskProgressChange',
        file,
        'extractAudio',
        safePercent,
      );
    }
  };
  const taskContext = getTaskContext();
  const fileUuid = file?.uuid || taskContext?.fileUuid;
  const signal = taskContext?.signal;
  const unregister = () => {
    if (fileUuid) runningCommands.delete(fileUuid);
  };
  const cleanupPartial = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (err) {
      logMessage(`cleanup partial subtitle failed: ${err}`, 'warning');
    }
  };

  return new Promise((resolve, reject) => {
    try {
      const command = ffmpeg(`${videoPath}`)
        .outputOptions(['-map', `0:s:${subIndex}`, '-c:s', 'srt', '-y'])
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract embedded subtitle start ${str}`, 'info');
        })
        .on('progress', function (progress) {
          onProgress(progress?.percent || 0);
        })
        .on('end', function () {
          unregister();
          onProgress(100);
          logMessage(`extract embedded subtitle done!`, 'info');
          resolve();
        })
        .on('error', function (err) {
          unregister();
          cleanupPartial();
          if (signal?.aborted) {
            logMessage(`extract embedded subtitle cancelled`, 'warning');
            reject(new TaskCancelledError());
            return;
          }
          logMessage(`extract embedded subtitle error: ${err}`, 'error');
          reject(err);
        });
      if (fileUuid) runningCommands.set(fileUuid, command);
      command.save(`${outPath}`);
    } catch (err) {
      unregister();
      cleanupPartial();
      logMessage(`ffmpeg extract embedded subtitle error: ${err}`, 'error');
      reject(err);
    }
  });
};
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc -p tsconfig.json`
Expected: 无输出，退出码 0。

- [ ] **Step 4: 提交**

```bash
git add main/helpers/audioProcessor.ts
git commit -m "feat(subtitle): add probe/extract for embedded subtitles in audioProcessor"
```

---

## Task 3: 接入生成管线（`fileProcessor.ts`）

**Files:**

- Modify: `main/helpers/fileProcessor.ts`（import + 替换生成分支）

- [ ] **Step 1: 调整 import**

将 `main/helpers/fileProcessor.ts` 第 6 行：

```ts
import { extractAudioFromVideo } from './audioProcessor';
```

替换为：

```ts
import {
  extractAudioFromVideo,
  probeEmbeddedSubtitles,
  extractEmbeddedSubtitle,
} from './audioProcessor';
import { canHaveEmbeddedSubtitle, srtHasCues } from './embeddedSubtitleParser';
```

- [ ] **Step 2: 替换生成分支**

将 `fileProcessor.ts` 中从 `// 处理非字幕文件 - 需要生成字幕的情况`（`if (!isSubtitleFile && shouldGenerateSubtitle) {`）到其对应闭合 `}`（即 `} else if (isSubtitleFile) {` 之前）整段替换为：

```ts
    // 处理非字幕文件 - 需要生成字幕的情况
    if (!isSubtitleFile && shouldGenerateSubtitle) {
      const templateData = {
        fileName,
        sourceLanguage,
        targetLanguage,
        model,
        translateProvider: provider.name,
      };

      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData,
      );

      file.srtFile = path.join(directory, `${sourceSrtFileName}.srt`);

      // 优先尝试直接抽取内封文本软字幕：命中则复用「提取/听写」两节点、跳过抽音频 + ASR
      let usedEmbedded = false;
      if (canHaveEmbeddedSubtitle(fileExtension)) {
        try {
          throwIfTaskCancelled();
          const textTracks = (await probeEmbeddedSubtitles(filePath)).filter(
            (t) => t.isText,
          );
          if (textTracks.length > 0) {
            const picked = textTracks[0];
            logMessage(
              `found ${textTracks.length} embedded text subtitle(s) in ${fileName}, extracting track s:${picked.subIndex} (${picked.codec})`,
              'info',
            );
            // 提取节点：抽第一条文本轨
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: 'loading',
            });
            await extractEmbeddedSubtitle(
              filePath,
              picked.subIndex,
              file.srtFile,
              event,
              file,
            );
            const srtContent = fs.readFileSync(file.srtFile, 'utf-8');
            if (!srtHasCues(srtContent)) {
              throw new Error('extracted embedded subtitle has no cues');
            }
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: 'done',
            });
            // 听写节点：字幕文件已就绪
            event.sender.send('taskFileChange', {
              ...file,
              extractSubtitle: 'loading',
            });
            event.sender.send('taskFileChange', {
              ...file,
              extractSubtitle: 'done',
            });
            usedEmbedded = true;
          }
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) {
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: '',
              extractSubtitle: '',
            });
            throw new TaskCancelledError();
          }
          logMessage(
            `embedded subtitle extraction failed for ${fileName}, fallback to ASR: ${error}`,
            'warning',
          );
        }
      }

      if (!usedEmbedded) {
        try {
          // 提取音频
          logMessage(`extract audio for ${fileName}`, 'info');
          event.sender.send('taskFileChange', {
            ...file,
            extractAudio: 'loading',
          });
          throwIfTaskCancelled();
          const tempAudioFile = await extractAudioFromVideo(event, file);
          event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });

          // 如果开启了保存音频选项，则复制一份到视频同目录
          if (saveAudio) {
            const audioFileName = `${fileName}.wav`;
            const targetAudioPath = path.join(directory, audioFileName);
            file.audioFile = targetAudioPath;
            logMessage(`Saving audio file to: ${targetAudioPath}`, 'info');
            fs.copyFileSync(tempAudioFile, targetAudioPath);
          }

          // 生成字幕
          logMessage(`generate subtitle ${file.srtFile}`, 'info');
          throwIfTaskCancelled();
          await generateSubtitle(event, file, formData, hasOpenAiWhisper);
        } catch (error) {
          if (isTaskCancelledError(error) || isTaskCancelled()) {
            // 用户取消：把本轮 loading 阶段回退为待处理
            event.sender.send('taskFileChange', {
              ...file,
              extractAudio: '',
              extractSubtitle: '',
            });
            throw new TaskCancelledError();
          }
          // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
          // 这里只需要继续抛出错误，中断后续流程
          throw error;
        }
      }
    } else if (isSubtitleFile) {
```

- [ ] **Step 3: 类型检查 + 单测**

Run: `npx tsc -p tsconfig.json && npm run test:engines`
Expected: tsc 无输出退出 0；单测末行 `... 0 failed`。

- [ ] **Step 4: 提交**

```bash
git add main/helpers/fileProcessor.ts
git commit -m "feat(subtitle): extract embedded soft subtitles before ASR with fallback"
```

---

## Task 4: 端到端手测验证

> 内封探测/抽取依赖真实媒体与 electron 运行时，用运行中应用验证。需准备测试素材（见下）。

**准备素材：**

- `withtext.mkv`：含 1 条 subrip/ass 文本字幕的视频。
- `mixed.mkv`：含图形字幕（PGS）在前、文本字幕在后的视频。
- `movtext.mp4`：含 mov_text 字幕的 mp4。
- `nosub.mp4`：无字幕 mp4。
- 任意 `.mp3` 音频。

> 若无现成素材，可用系统 ffmpeg 临时合成（仅造素材，不影响应用逻辑）：
> `ffmpeg -i nosub.mp4 -i sub.srt -c copy -c:s srt withtext.mkv`

- [ ] **Step 1: 启动应用**

Run: `npm run dev`

- [ ] **Step 2: 验证矩阵**（建"视频转字幕"任务，逐个导入，观察任务行节点与日志）

| 素材           | 期望                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `withtext.mkv` | 提取(秒级 done) → 听写(立即 done)，**不**经过抽音频/ASR；日志含 `found ... embedded text subtitle(s)`；产出 SRT 内容正确 |
| `mixed.mkv`    | 抽到**文本**轨（非 PGS）；SRT 为文本字幕                                                                                 |
| `movtext.mp4`  | 直提成功                                                                                                                 |
| `nosub.mp4`    | 一次探测后走正常抽音频 + ASR（日志无 `found ... embedded`）                                                              |
| `.mp3`         | 不探测（无 `found`/无探测日志），直接 ASR                                                                                |

- [ ] **Step 3: 验证回退与取消**

- 对 `withtext.mkv` 任务运行中点"取消"：节点回退待处理、无残留半成品 `.srt`。
- （可选）临时把 `extractEmbeddedSubtitle` 的 `-map 0:s:${subIndex}` 改成越界值制造失败，确认日志出现 `fallback to ASR` 且任务最终经 ASR 完成；验证后还原。

- [ ] **Step 4: 终检 gates**

Run: `npx tsc -p tsconfig.json && npm run test:engines`
Expected: 均通过。

- [ ] **Step 5: 收尾**

确认 Task 1–3 均已提交、工作区干净（`git status`）。如手测中有修正，按需补提交。

---

## Self-Review

**Spec coverage:**

- 自动探测 + 直提 + 跳过 ASR → Task 3。
- 复用 extractAudio/extractSubtitle 节点、状态机零改 → Task 3（仅发既有 key）。
- 路线 B（内置 ffmpeg、`-i` stderr 解析 + `-map -c:s srt`）→ Task 1 解析 + Task 2 IO。
- 扩展名白名单①（含 mp4/mov）→ Task 1 `canHaveEmbeddedSubtitle` + 单测。
- 多轨取第一条文本轨（跳过图形轨）→ Task 1 `subIndex` 顺序 + Task 3 `filter(isText)[0]`；`mixed.mkv` 手测。
- 图形字幕回退 ASR → `isText=false` 被过滤 → `textTracks` 空 → 走 ASR。
- 抽取失败/空字幕回退 → Task 3 catch + `srtHasCues` 兜底。
- 取消语义 → Task 2 signal + Task 3 cancel 分支。
- 探测预过滤省开销 → Task 3 `canHaveEmbeddedSubtitle` 门禁。
- 不依赖系统 PATH → 复用 `audioProcessor.ts` 的 `ffmpegPath`。

**Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码与确切命令。

**Type consistency:** `EmbeddedSubtitleStream`/`parseSubtitleStreams`/`canHaveEmbeddedSubtitle`/`srtHasCues`（Task 1）与 `probeEmbeddedSubtitles`/`extractEmbeddedSubtitle`（Task 2）签名在 Task 3 调用处一致；进度统一用 `'extractAudio'` key；阶段状态值 `'loading'|'done'|''` 与现有用法一致。
