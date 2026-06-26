/**
 * 用 macOS `say` + 项目自带 ffmpeg（`@ffmpeg-installer/ffmpeg`）把 `fixtures.ts` 的三语种脚本
 * 合成为 16kHz 单声道 PCM WAV（whisper.cpp 要求的输入格式），写入 gitignored 的 `.longgap/audio/`。
 *
 * macOS 专用（依赖系统 `say`）。其它平台请自备同名 WAV（`<lang>.wav`）放进 audio 目录。
 *
 * 单独运行（生成全部语种）：
 *   tsc 后 `node .../gen-audio.js`，或经 `npm run longgap:gen`（见 package.json）。
 * 也被 `run.ts` 作为库调用（缺音频时按需补齐）。
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import {
  LONGGAP_FIXTURES,
  buildSayInput,
  designedSilenceSeconds,
  type LongGapFixture,
} from './fixtures';

/** 仓库根目录：npm 脚本从根运行，故用 cwd。 */
export const REPO_ROOT = process.cwd();
/** 生成音频目录（gitignored）。可用 LONGGAP_AUDIO_DIR 覆盖。 */
export const AUDIO_DIR =
  process.env.LONGGAP_AUDIO_DIR || path.join(REPO_ROOT, '.longgap', 'audio');

export function wavPathFor(lang: string): string {
  return path.join(AUDIO_DIR, `${lang}.wav`);
}

export function musicWavPathFor(lang: string): string {
  return path.join(AUDIO_DIR, `${lang}.music.wav`);
}

/** 背景音乐床音量（相对语音；越大越压速 VAD/幻觉）。可用 LONGGAP_BGM_VOLUME 覆盖。 */
export const BGM_VOLUME = process.env.LONGGAP_BGM_VOLUME || '0.12';

/** macOS 才能用 `say` 合成。 */
export function canSynthesize(): boolean {
  return process.platform === 'darwin';
}

/**
 * 确保某语种的 WAV 存在：已存在直接返回；缺失且在 macOS 则用 say+ffmpeg 合成；
 * 缺失且非 macOS 抛错（提示自备音频）。
 */
export function ensureAudio(fix: LongGapFixture): string {
  const wav = wavPathFor(fix.lang);
  if (fs.existsSync(wav)) return wav;
  if (!canSynthesize()) {
    throw new Error(
      `缺少音频 ${wav}，且当前非 macOS 无法用 say 合成。请自备 16k 单声道 WAV 放到该路径。`,
    );
  }
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const aiff = path.join(AUDIO_DIR, `${fix.lang}.aiff`);
  const sayInput = buildSayInput(fix);
  // say -v <音色> -o <aiff> "<文本，含 [[slnc ms]] 静音>"
  execFileSync('say', ['-v', fix.sayVoice, '-o', aiff, sayInput], {
    stdio: 'inherit',
  });
  // 转 16k 单声道 PCM s16le WAV
  execFileSync(
    ffmpegInstaller.path,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      aiff,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav,
    ],
    { stdio: 'inherit' },
  );
  fs.rmSync(aiff, { force: true });
  return wav;
}

/**
 * 在干净语音上叠加「连续背景音乐床」（A 大三和弦 + 轻微颤音），**含句间长静音处**也有音乐
 * → 压力测试：①Silero 能否仍把音乐段判为非语音、还原句间停顿 ②whisper 是否在纯音乐处幻觉。
 * 仅需 ffmpeg（跨平台自带），故非 macOS 只要有干净 WAV 也能派生 music 变体。
 */
export function ensureMusicAudio(fix: LongGapFixture): string {
  const base = ensureAudio(fix);
  const out = musicWavPathFor(fix.lang);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  execFileSync(
    ffmpegInstaller.path,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      base,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=277',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330',
      '-filter_complex',
      `[1][2][3]amix=inputs=3:normalize=0[ch];` +
        `[ch]volume=${BGM_VOLUME},tremolo=f=5:d=0.4[bg];` +
        `[0][bg]amix=inputs=2:duration=first:normalize=0[out]`,
      '-map',
      '[out]',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      out,
    ],
    { stdio: 'inherit' },
  );
  return out;
}

/** 生成全部语种（clean + music 变体，standalone 入口）。 */
export function generateAll(): void {
  if (!canSynthesize()) {
    console.error('gen-audio: 当前非 macOS，无法用 say 合成。请自备 WAV。');
    process.exit(1);
  }
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  for (const fix of LONGGAP_FIXTURES) {
    const wav = ensureAudio(fix);
    const music = ensureMusicAudio(fix);
    console.log(
      `[gen] ${fix.label.padEnd(8)} voice=${fix.sayVoice.padEnd(10)} ` +
        `设计静音≈${designedSilenceSeconds(fix).toFixed(0)}s → ${wav} + ${path.basename(music)}`,
    );
  }
}

if (require.main === module) generateAll();
