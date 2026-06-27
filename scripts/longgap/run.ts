/**
 * 多语种「长静音」真机回归 harness（内置 whisper.cpp 0-fork 时间轴管道）。
 *
 * 不经 Electron：直接 dlopen whisper addon 取 per-token 转写（与 builtinEngine 同参数），跑「真实」
 * sherpa worker 的 detectSpeech 取 Silero 语音边界（失败回退能量法），再用「真实」
 * subtitleSegmentation 重建时间轴，逐语种 × 模型 × VAD on/off 对比，量化：
 *   - cues：字幕条数（粒度）
 *   - gaps(>0.4s)：句间停顿数（停顿还原；越接近真实句数越好）
 *   - inSilence：与所有语音段零重叠的 cue（VAD-off 多为深静音幻觉；应为 0 或贴边界真实词）
 *   - short(<0.8s)：文本≥2 字却一闪而过的过短 cue（D15 目标 0）
 *
 * 前置条件（macOS 手动冒烟，非 CI）：
 *   1) whisper 模型 ggml-*.bin 放在 LONGGAP_MODELS_DIR（默认 ~/Downloads/translate/models）
 *   2) extraResources/ 下有 addon.node / ggml-silero / sherpa native+worker（随仓库或本地构建）
 *   3) 首跑会用 macOS `say` 自动合成三语种长静音音频到 .longgap/audio/（见 gen-audio.ts）
 *
 * 运行：npm run test:longgap
 * 可调 env：LONGGAP_LANGS=zh,en,ja  LONGGAP_MODELS=medium,base-q8_0
 *           LONGGAP_MODELS_DIR=/path/to/models  LONGGAP_AUDIO_DIR=...  LONGGAP_OUT_DIR=...
 */
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import {
  tokensToTriples,
  groupTokenCues,
  mergeShortCues,
  enforceMinDisplayDuration,
  clampTriplesToSpeechSegments,
  clampCuesToDominantSegments,
  dropCuesInDeepSilence,
  vadSegmentsToSpeech,
  type TokenTriple,
} from '../../main/helpers/subtitleSegmentation';
import {
  LONGGAP_FIXTURES,
  designedSilenceSeconds,
  type LongGapFixture,
} from './fixtures';
import { ensureAudio, ensureMusicAudio, REPO_ROOT } from './gen-audio';

const EXTRA = path.join(REPO_ROOT, 'extraResources');
const ADDON = path.join(EXTRA, 'addons', 'addon.node');
const GGML_VAD = path.join(EXTRA, 'ggml-silero-v6.2.0.bin');
const SILERO_ONNX = path.join(EXTRA, 'sherpa', 'vad', 'silero_vad.onnx');
const SHERPA_LIB_DIR = path.join(EXTRA, 'sherpa', 'native', 'darwin-arm64');
const WORKER = path.join(EXTRA, 'sherpa', 'worker', 'sherpa-worker.js');

const MODELS_DIR =
  process.env.LONGGAP_MODELS_DIR ||
  '/Users/xiaodong/Downloads/translate/models';
const OUT_DIR =
  process.env.LONGGAP_OUT_DIR || path.join(REPO_ROOT, '.longgap', 'out');
const LANGS = (process.env.LONGGAP_LANGS || 'zh,en,ja')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = (process.env.LONGGAP_MODELS || 'medium,base-q8_0')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// 素材变体：clean=纯语音长静音；music=叠加连续背景音乐（含静音处）压力测试 VAD/幻觉。
const VARIANTS = (process.env.LONGGAP_VARIANTS || 'clean,music')
  .split(',')
  .map((s) => s.trim())
  .filter((v) => v === 'clean' || v === 'music');

type Seg = { start: number; end: number };

// ---------- whisper addon（复刻 addonLoader.tryLoadCandidate）----------
function loadWhisper(): (p: Record<string, unknown>) => Promise<any> {
  const mod: any = { exports: { whisper: null } };
  process.dlopen(mod, ADDON);
  if (typeof mod.exports.whisper !== 'function') {
    throw new Error('addon exports no whisper()');
  }
  return promisify(mod.exports.whisper);
}

function whisperParams(
  model: string,
  maxLen: number,
  vad: boolean,
  lang: string,
  wav: string,
): Record<string, unknown> {
  return {
    language: lang,
    model: path.join(MODELS_DIR, `ggml-${model}.bin`),
    fname_inp: wav,
    use_gpu: true,
    flash_attn: false,
    no_prints: true,
    comma_in_time: false,
    translate: false,
    no_timestamps: false,
    audio_ctx: 0,
    // 原生 segment-aware 逐 token 输出（与 builtinEngine 同）：token_timestamps + max_len=0。
    token_timestamps: true,
    max_len: maxLen,
    print_progress: false,
    max_context: -1,
    vad,
    vad_model: GGML_VAD,
    vad_threshold: 0.5,
    vad_min_speech_duration_ms: 250,
    vad_min_silence_duration_ms: 100,
    vad_max_speech_duration_s: 0,
    vad_speech_pad_ms: 200,
    vad_samples_overlap: 0.1,
  };
}

// ---------- Silero 边界：跑「真实」worker 的 detectSpeech ----------
function sileroSegments(wav: string): Promise<Seg[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      env: {
        ...process.env,
        SHERPA_ONNX_LIB_DIR: SHERPA_LIB_DIR,
        PATH: `${SHERPA_LIB_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
        DYLD_LIBRARY_PATH: `${SHERPA_LIB_DIR}${path.delimiter}${
          process.env.DYLD_LIBRARY_PATH ?? ''
        }`,
        LD_LIBRARY_PATH: `${SHERPA_LIB_DIR}${path.delimiter}${
          process.env.LD_LIBRARY_PATH ?? ''
        }`,
      },
    });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('silero worker timeout'));
    }, 120000);
    w.on('message', (msg: any) => {
      if (msg.type === 'done') {
        clearTimeout(timer);
        w.terminate();
        resolve((msg.segments || []) as Seg[]);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        w.terminate();
        reject(new Error(msg.message));
      }
    });
    w.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    w.postMessage({
      type: 'detectSpeech',
      id: 'v1',
      audioFile: wav,
      vadModel: SILERO_ONNX,
      params: {
        vad_threshold: 0.5,
        vad_min_speech_duration_ms: 250,
        vad_min_silence_duration_ms: 100,
        vad_max_speech_duration_s: 0,
      },
    });
  });
}

// ---------- 能量边界（内联 PR #341 analyzePcm16WavEnergy + speechBoundary.energySegments）----------
const FRAME_MS = 20;
const ENERGY_BRIDGE_SILENCE_SECONDS = 0.2;
const ENERGY_MIN_SPEECH_SECONDS = 0.12;

function percentile(sorted: number[], ratio: number): number {
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * ratio)),
  );
  return sorted[i];
}
function thresholdDb(frameDb: number[]): number {
  const sorted = frameDb
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return -50;
  return Math.max(
    Math.min(percentile(sorted, 0.15) + 12, percentile(sorted, 0.95) - 6),
    -55,
  );
}
function energySegments(wav: string): Seg[] {
  const buf = fs.readFileSync(wav);
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const dataOffset = 44;
  const dataSize = buf.length - 44;
  const samplesPerFrame = Math.max(
    1,
    Math.round((sampleRate * FRAME_MS) / 1000),
  );
  const fd = samplesPerFrame / sampleRate;
  const bytesPerFrameSample = 2 * channels;
  const sampleFrames = Math.floor(dataSize / bytesPerFrameSample);
  const frameCount = Math.ceil(sampleFrames / samplesPerFrame);
  const frameDb: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const first = frame * samplesPerFrame;
    const last = Math.min(sampleFrames, first + samplesPerFrame);
    let sum = 0;
    let n = 0;
    for (let sf = first; sf < last; sf += 1) {
      for (let c = 0; c < channels; c += 1) {
        const off = dataOffset + (sf * channels + c) * 2;
        if (off + 2 > dataOffset + dataSize) break;
        const s = buf.readInt16LE(off) / 32768;
        sum += s * s;
        n += 1;
      }
    }
    frameDb.push(
      20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(n, 1)), 1e-8)),
    );
  }
  const th = thresholdDb(frameDb);
  const bridgeFrames = Math.round(ENERGY_BRIDGE_SILENCE_SECONDS / fd);
  const raw: Seg[] = [];
  let runStart = -1;
  for (let i = 0; i < frameDb.length; i += 1) {
    const speech = frameDb[i] >= th;
    if (speech && runStart < 0) runStart = i;
    else if (!speech && runStart >= 0) {
      raw.push({ start: runStart * fd, end: i * fd });
      runStart = -1;
    }
  }
  if (runStart >= 0)
    raw.push({ start: runStart * fd, end: frameDb.length * fd });
  const bridged: Seg[] = [];
  for (const seg of raw) {
    const prev = bridged[bridged.length - 1];
    if (prev && seg.start - prev.end < bridgeFrames * fd) prev.end = seg.end;
    else bridged.push({ ...seg });
  }
  return bridged.filter((s) => s.end - s.start >= ENERGY_MIN_SPEECH_SECONDS);
}

// ---------- SRT / 指标工具 ----------
function parseTime(t?: string): number | null {
  if (!t) return null;
  const parts = t.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}
function fmt(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (v: number, l = 2) => String(v).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(
    Math.floor(ms / 1000) % 60,
  )},${p(ms % 1000, 3)}`;
}
function toSrt(cues: TokenTriple[]): string {
  return (
    cues
      .map((c, i) => {
        const s = parseTime(c[0]) ?? 0;
        const e = parseTime(c[1]) ?? 0;
        return `${i + 1}\n${fmt(s)} --> ${fmt(e)}\n${(c[2] || '').trim()}\n`;
      })
      .join('\n') + '\n'
  );
}
function printSegs(name: string, segs: Seg[]): void {
  const head = segs
    .slice(0, 30)
    .map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`)
    .join(' ');
  console.log(
    `  [${name}] ${segs.length} segs: ${head}${segs.length > 30 ? ' ...' : ''}`,
  );
}
function gapCount(cues: TokenTriple[], minGap = 0.4): number {
  let g = 0;
  for (let i = 1; i < cues.length; i += 1) {
    const prevEnd = parseTime(cues[i - 1][1]) ?? 0;
    const curStart = parseTime(cues[i][0]) ?? 0;
    if (curStart - prevEnd > minGap) g += 1;
  }
  return g;
}
function span(cues: TokenTriple[]): string {
  if (!cues.length) return '(empty)';
  return `${fmt(parseTime(cues[0][0]) ?? 0)}..${fmt(
    parseTime(cues[cues.length - 1][1]) ?? 0,
  )}`;
}
/** 与所有语音段「零重叠」的 cue（整条落在静音里）——VAD-off 时多为幻觉。 */
function silenceCues(cues: TokenTriple[], segs: Seg[]): TokenTriple[] {
  const overlaps = (s: number, e: number) =>
    segs.some((seg) => Math.min(e, seg.end) - Math.max(s, seg.start) > 0.01);
  return cues.filter((c) => {
    const s = parseTime(c[0]) ?? 0;
    const e = parseTime(c[1]) ?? 0;
    return e > s && !overlaps(s, e);
  });
}
/** 「文本正常（≥2 字）但显示时长 < minDur 秒」的过短 cue 数（D15 目标：一闪而过看不清）。 */
function shortCueCount(cues: TokenTriple[], minDur = 0.8): number {
  let n = 0;
  for (const c of cues) {
    const s = parseTime(c[0]) ?? 0;
    const e = parseTime(c[1]) ?? 0;
    const hasText = (c[2] || '').trim().length >= 2;
    if (e > s && hasText && e - s < minDur) n += 1;
  }
  return n;
}
function report(label: string, cues: TokenTriple[], segs: Seg[]): void {
  const halluc = silenceCues(cues, segs);
  console.log(
    `    ${label.padEnd(30)} cues=${String(cues.length).padStart(3)}  gaps=${String(
      gapCount(cues),
    ).padStart(
      2,
    )}  inSilence=${String(halluc.length).padStart(2)}  short=${String(
      shortCueCount(cues),
    ).padStart(2)}  span=${span(cues)}`,
  );
  if (halluc.length) {
    console.log(
      `        in-silence cues: ${halluc
        .slice(0, 6)
        .map(
          (c) =>
            `[${fmt(parseTime(c[0]) ?? 0)}»${(c[2] || '').trim().slice(0, 8)}]`,
        )
        .join(' ')}`,
    );
  }
}

type Variant = 'clean' | 'music';

interface SummaryRow {
  lang: string;
  variant: Variant;
  model: string;
  vad: 'on' | 'off';
  cues: number;
  gaps: number;
  inSilence: number;
  short: number;
}

// ---------- 单语种处理（逐变体）----------
async function runLanguage(
  whisper: (p: Record<string, unknown>) => Promise<any>,
  fix: LongGapFixture,
  summary: SummaryRow[],
): Promise<void> {
  console.log(
    `\n\n################ ${fix.label} (${fix.lang}) ################`,
  );
  console.log(`设计静音≈${designedSilenceSeconds(fix).toFixed(0)}s`);
  for (const variant of VARIANTS as Variant[]) {
    await runVariant(whisper, fix, variant, summary);
  }
}

async function runVariant(
  whisper: (p: Record<string, unknown>) => Promise<any>,
  fix: LongGapFixture,
  variant: Variant,
  summary: SummaryRow[],
): Promise<void> {
  const wav = variant === 'music' ? ensureMusicAudio(fix) : ensureAudio(fix);
  console.log(`\n==== variant: ${variant} ====`);
  console.log(`WAV: ${wav}`);

  let silero: Seg[] = [];
  try {
    silero = await sileroSegments(wav);
    console.log(`Silero (real worker): ${silero.length} segments`);
  } catch (e) {
    console.log(`Silero FAILED -> ${e}`);
  }
  printSegs('silero', silero);
  const energy = energySegments(wav);
  printSegs('energy', energy);
  const boundarySource = silero.length ? 'silero' : 'energy';
  const segments = silero.length ? silero : energy;
  const totalSpeech = segments.reduce((a, s) => a + (s.end - s.start), 0);
  const audioEnd = segments.reduce((a, s) => Math.max(a, s.end), 0);
  console.log(
    `chosen boundary: ${boundarySource} (${segments.length} segs, speech≈${totalSpeech.toFixed(
      1,
    )}s, silence≈${(audioEnd - totalSpeech).toFixed(1)}s)` +
      (variant === 'music'
        ? `  ※music：energy 法会被音乐填满(对照 ${energy.length} 段)，靠 Silero 区分语音`
        : ''),
  );
  console.log(
    '  columns: cues / gaps(>0.4s) / inSilence(零重叠语音段=幻觉嫌疑) / short(<0.8s 过短) / span',
  );

  for (const model of MODELS) {
    const modelFile = path.join(MODELS_DIR, `ggml-${model}.bin`);
    if (!fs.existsSync(modelFile)) {
      console.log(`\n#### ${model}: SKIP (missing ${modelFile})`);
      continue;
    }
    console.log(`\n#### model: ${model} ####`);
    for (const useVad of [true, false]) {
      let triples: TokenTriple[] = [];
      let internalSpeech: Seg[] = [];
      try {
        const r = await whisper(whisperParams(model, 0, useVad, fix.lang, wav));
        internalSpeech = vadSegmentsToSpeech(
          (r?.vadSegments || []) as Array<{ t0: number; t1: number }>,
        );
        triples = tokensToTriples(
          (r?.tokens || []) as Array<{ text: string; t0: number; t1: number }>,
        );
        if (triples.length === 0 && Array.isArray(r?.transcription)) {
          console.log(
            '    (旧版 addon 无 token 输出，回退段级 transcription 仅供对照)',
          );
          triples = r.transcription as TokenTriple[];
        }
      } catch (e) {
        console.log(`  VAD ${useVad ? 'ON' : 'OFF'} run failed: ${e}`);
        continue;
      }
      console.log(
        `  --- VAD ${useVad ? 'ON ' : 'OFF'}  tokens=${triples.length}`,
      );
      // 与 builtinEngine 同分支：VAD 开 → token 级夹回内部 VAD 段；VAD 关 → token 时间全程线性，
      // 改用能量段做 cue 级「主导段」收敛 + 深静音丢弃（不碎词）。
      const groupOnly = groupTokenCues(triples);
      report('group-only', groupOnly, segments);
      let refined: TokenTriple[];
      if (internalSpeech.length > 0) {
        refined = mergeShortCues(
          groupTokenCues(clampTriplesToSpeechSegments(triples, internalSpeech)),
        );
      } else {
        refined = energy.length
          ? dropCuesInDeepSilence(
              mergeShortCues(clampCuesToDominantSegments(groupOnly, energy)),
              energy,
            )
          : mergeShortCues(groupOnly);
      }
      const full = enforceMinDisplayDuration(refined);
      console.log(
        `    [diag] short<0.8s: ${shortCueCount(refined)} → ${shortCueCount(full)} after minDisp (D15)`,
      );
      report('full = branch+mergeShort+minDisp', full, segments);

      summary.push({
        lang: fix.lang,
        variant,
        model,
        vad: useVad ? 'on' : 'off',
        cues: full.length,
        gaps: gapCount(full),
        inSilence: silenceCues(full, segments).length,
        short: shortCueCount(full),
      });
      const tag = `${fix.lang}.${variant}.${model}.vad${useVad ? 'on' : 'off'}`;
      fs.writeFileSync(
        path.join(OUT_DIR, `${tag}.grouponly.srt`),
        toSrt(groupOnly),
      );
      fs.writeFileSync(path.join(OUT_DIR, `${tag}.full.srt`), toSrt(full));
    }
  }
}

function printSummary(summary: SummaryRow[]): void {
  console.log('\n\n======== 汇总（生产管道 full）========');
  console.log(
    '  lang  variant  model        VAD  cues  gaps  inSilence  short(<0.8s)',
  );
  for (const r of summary) {
    console.log(
      `  ${r.lang.padEnd(4)}  ${r.variant.padEnd(7)}  ${r.model.padEnd(
        11,
      )}  ${r.vad.padEnd(3)}  ${String(r.cues).padStart(4)}  ${String(
        r.gaps,
      ).padStart(4)}  ${String(r.inSilence).padStart(9)}  ${String(
        r.short,
      ).padStart(11)}`,
    );
  }
  console.log(
    '\n  期望：gaps>0（句间停顿还原）、inSilence≈0（或贴边界真实词）、short=0（D15）。',
  );
  console.log(
    '  music 变体额外关注：背景音乐是否让 gaps 消失（停顿被音乐填平）或 inSilence 激增（音乐段幻觉）。',
  );
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`addon: ${ADDON}`);
  console.log(`models dir: ${MODELS_DIR}`);
  console.log(
    `langs: ${LANGS.join(', ')}  models: ${MODELS.join(', ')}  variants: ${VARIANTS.join(', ')}`,
  );
  if (!fs.existsSync(ADDON)) {
    throw new Error(
      `whisper addon 缺失：${ADDON}（请先本地构建 / 放置 extraResources）`,
    );
  }
  const whisper = loadWhisper();
  const fixtures = LONGGAP_FIXTURES.filter((f) => LANGS.includes(f.lang));
  if (!fixtures.length) {
    throw new Error(`LONGGAP_LANGS=${LANGS.join(',')} 未匹配任何 fixture`);
  }
  const summary: SummaryRow[] = [];
  for (const fix of fixtures) await runLanguage(whisper, fix, summary);
  printSummary(summary);
  console.log(`\nSRT 写入 ${OUT_DIR}`);
})().catch((e) => {
  console.error('longgap harness error:', e);
  process.exit(1);
});
