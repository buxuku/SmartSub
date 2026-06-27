/**
 * 字幕效果「三档」真机验证 harness（builtin / whisper.cpp）。
 *
 * 目的（subtitle-outcome-presets §3b.5 / §8.2 的「可复现证据」版）：
 * 证明「文字最准 / 均衡 / 最干净最稳」三档在**真实音频**上产出可感的
 * 「更全·更细 ↔ 更干净·更稳」梯度——而不只是单测层面的参数映射正确。
 *
 * 关键：档位 → 底层参数走**真实** resolveEffectiveSettings（outcomePresets.ts），
 * 即被测系统本身；whisper 调用与时间轴管道与 run.ts 同源（同参数、同 subtitleSegmentation），
 * 这样观察到的差异只来自「档位」这一个变量。
 *
 * builtin 三档（resolveEffectiveSettings 派生）：
 *   accurate 文字最准 → VAD off · maxContext=-1            （分段最细、字最全、易在静音冒字）
 *   balanced 均衡     → VAD on  · maxContext=-1            （默认）
 *   clean    最干净最稳→ VAD on  · maxContext=0 · 抗重复    （合并更粗、静音干净、少鬼畜）
 *
 * 量化梯度（对「生产管道 full cues」）：
 *   - chars     ：字幕总字数（更全 ↔ 更省；accurate 通常最多）
 *   - dup       ：与前一条文本完全相同的「鬼畜/重复」cue 数（clean 应最少）
 *   - inSilence ：与所有语音段零重叠的 cue（深静音幻觉；accurate=VAD off 通常最多、clean≈0）
 *   - cues      ：字幕条数（accurate 更细、clean 合并更粗）
 *   - short     ：文本≥2 字却 <0.8s 一闪而过（D15 目标 0）
 *
 * 前置条件同 run.ts（extraResources 下 addon/ggml-silero/sherpa native+worker；
 * whisper 模型 ggml-*.bin 在 LONGGAP_MODELS_DIR；首跑用 macOS say 自动合成音频）。
 *
 * 运行：npm run test:longgap:outcomes
 * 可调 env：LONGGAP_LANGS=en           LONGGAP_MODELS=base-q8_0
 *           LONGGAP_VARIANTS=clean,music  LONGGAP_OUTCOMES=accurate,balanced,clean
 *           LONGGAP_MODELS_DIR=/path     LONGGAP_OUT_DIR=...
 */
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import {
  tokensToTriples,
  groupTokenCues,
  clampTriplesToSpeechSegments,
  clampCuesToDominantSegments,
  dropCuesInDeepSilence,
  vadSegmentsToSpeech,
  mergeShortCues,
  enforceMinDisplayDuration,
  type TokenTriple,
} from '../../main/helpers/subtitleSegmentation';
import {
  resolveEffectiveSettings,
  type SubtitleOutcome,
} from '../../main/helpers/engines/outcomePresets';
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
// 默认只跑 en + base-q8_0（快），便于快速取证；多语种/多模型按需用 env 放开。
const LANGS = (process.env.LONGGAP_LANGS || 'en')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = (process.env.LONGGAP_MODELS || 'base-q8_0')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const VARIANTS = (process.env.LONGGAP_VARIANTS || 'clean,music')
  .split(',')
  .map((s) => s.trim())
  .filter((v) => v === 'clean' || v === 'music') as Variant[];
// 验证的三档（custom 非预设、不参与梯度对比，故排除）。
const TIER_ORDER: SubtitleOutcome[] = ['accurate', 'balanced', 'clean'];
const OUTCOMES = (process.env.LONGGAP_OUTCOMES || 'accurate,balanced,clean')
  .split(',')
  .map((s) => s.trim())
  .filter((o): o is SubtitleOutcome => (TIER_ORDER as string[]).includes(o))
  .sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));

type Seg = { start: number; end: number };
type Variant = 'clean' | 'music';

const TIER_LABEL: Record<SubtitleOutcome, string> = {
  accurate: '文字最准',
  balanced: '均衡    ',
  clean: '最干净最稳',
  custom: '自定义  ',
};

// ---------- whisper addon（复刻 addonLoader.tryLoadCandidate；与 run.ts 同）----------
function loadWhisper(): (p: Record<string, unknown>) => Promise<any> {
  const mod: any = { exports: { whisper: null } };
  process.dlopen(mod, ADDON);
  if (typeof mod.exports.whisper !== 'function') {
    throw new Error('addon exports no whisper()');
  }
  return promisify(mod.exports.whisper);
}

// 与 run.ts 同参数；额外暴露 maxContext（档位差异点之一）。VAD 灵敏度对 builtin 档位无关，
// 保持 Standard 默认（档位映射 VAD 灵敏度是 sherpa 系的事，见 design D9）。
function whisperParams(
  model: string,
  maxLen: number,
  vad: boolean,
  maxContext: number,
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
    max_context: maxContext,
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

// ---------- Silero 边界：跑「真实」worker 的 detectSpeech（与 run.ts 同）----------
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

// ---------- 能量边界兜底（内联，与 run.ts 同）----------
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
function gapCount(cues: TokenTriple[], minGap = 0.4): number {
  let g = 0;
  for (let i = 1; i < cues.length; i += 1) {
    const prevEnd = parseTime(cues[i - 1][1]) ?? 0;
    const curStart = parseTime(cues[i][0]) ?? 0;
    if (curStart - prevEnd > minGap) g += 1;
  }
  return g;
}
/** 与所有语音段「零重叠」的 cue（整条落在静音里）——深静音幻觉嫌疑。 */
function silenceCueCount(cues: TokenTriple[], segs: Seg[]): number {
  const overlaps = (s: number, e: number) =>
    segs.some((seg) => Math.min(e, seg.end) - Math.max(s, seg.start) > 0.01);
  return cues.filter((c) => {
    const s = parseTime(c[0]) ?? 0;
    const e = parseTime(c[1]) ?? 0;
    return e > s && !overlaps(s, e);
  }).length;
}
/** 文本≥2 字但显示 <minDur 秒的过短 cue（一闪而过，D15 目标 0）。 */
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
/** 字幕总字数（去空白计长度）：更全 ↔ 更省的直接信号。 */
function totalChars(cues: TokenTriple[]): number {
  return cues.reduce((a, c) => a + (c[2] || '').replace(/\s+/g, '').length, 0);
}
/** 与前一条「完全相同文本」的 cue 数（鬼畜/重复）：clean 抗重复应最少。 */
function dupCueCount(cues: TokenTriple[]): number {
  let n = 0;
  for (let i = 1; i < cues.length; i += 1) {
    const prev = (cues[i - 1][2] || '').trim();
    const cur = (cues[i][2] || '').trim();
    if (cur && cur === prev) n += 1;
  }
  return n;
}

interface Row {
  lang: string;
  variant: Variant;
  model: string;
  outcome: SubtitleOutcome;
  vad: boolean;
  maxContext: number;
  cues: number;
  chars: number;
  dup: number;
  inSilence: number;
  short: number;
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function runGroup(
  whisper: (p: Record<string, unknown>) => Promise<any>,
  fix: LongGapFixture,
  variant: Variant,
  model: string,
  segments: Seg[],
  rows: Row[],
): Promise<void> {
  const wav = variant === 'music' ? musicWav(fix) : cleanWav(fix);
  console.log(`\n#### ${fix.lang}/${variant}/${model} ####`);
  console.log('  outcome      VAD  ctx  cues  chars  dup  inSilence  short');
  for (const outcome of OUTCOMES) {
    // 走真实 SUT：档位 → 底层参数。
    const eff = resolveEffectiveSettings(
      { subtitleOutcome: outcome, transcriptionEngine: 'builtin' },
      {},
    );
    const vad = eff.useVAD !== false;
    const reduceRep = eff.reduceRepetition === true;
    // 复刻 builtinEngine：reduceRepetition 开 → max_context=0，否则取派生 maxContext。
    const maxContext = reduceRep ? 0 : num(eff.maxContext, -1);

    let triples: TokenTriple[] = [];
    let internalSpeech: Seg[] = [];
    try {
      const r = await whisper(
        whisperParams(model, 0, vad, maxContext, fix.lang, wav),
      );
      internalSpeech = vadSegmentsToSpeech(
        (r?.vadSegments || []) as Array<{ t0: number; t1: number }>,
      );
      triples = tokensToTriples(
        (r?.tokens || []) as Array<{ text: string; t0: number; t1: number }>,
      );
      if (triples.length === 0 && Array.isArray(r?.transcription)) {
        triples = r.transcription as TokenTriple[];
      }
    } catch (e) {
      console.log(`  ${TIER_LABEL[outcome]}  run failed: ${e}`);
      continue;
    }
    const groupOnly = groupTokenCues(triples);
    // 与 builtinEngine 同分支：VAD 开 → token 级夹回内部 VAD 段；VAD 关（文字最准）→ token 时间
    // 全程线性，改用能量段做 cue 级「主导段」收敛 + 深静音丢弃（不碎词）。
    let refined: TokenTriple[];
    if (internalSpeech.length > 0) {
      refined = mergeShortCues(
        groupTokenCues(clampTriplesToSpeechSegments(triples, internalSpeech)),
      );
    } else {
      const energy = energySegments(wav);
      refined = energy.length
        ? dropCuesInDeepSilence(
            mergeShortCues(clampCuesToDominantSegments(groupOnly, energy)),
            energy,
          )
        : mergeShortCues(groupOnly);
    }
    const full = enforceMinDisplayDuration(refined);
    const row: Row = {
      lang: fix.lang,
      variant,
      model,
      outcome,
      vad,
      maxContext,
      cues: full.length,
      chars: totalChars(full),
      dup: dupCueCount(full),
      inSilence: silenceCueCount(full, segments),
      short: shortCueCount(full),
    };
    rows.push(row);
    console.log(
      `  ${TIER_LABEL[outcome]}  ${(vad ? 'on ' : 'off').padEnd(3)}  ${String(
        maxContext,
      ).padStart(3)}  ${String(row.cues).padStart(4)}  ${String(
        row.chars,
      ).padStart(5)}  ${String(row.dup).padStart(3)}  ${String(
        row.inSilence,
      ).padStart(9)}  ${String(row.short).padStart(5)}`,
    );
    const tag = `${fix.lang}.${variant}.${model}.tier-${outcome}`;
    fs.writeFileSync(
      path.join(OUT_DIR, `${tag}.grouponly.srt`),
      toSrt(groupOnly),
    );
    fs.writeFileSync(path.join(OUT_DIR, `${tag}.full.srt`), toSrt(full));
  }
}

function cleanWav(fix: LongGapFixture): string {
  return ensureAudio(fix);
}
function musicWav(fix: LongGapFixture): string {
  return ensureMusicAudio(fix);
}

async function boundariesFor(wav: string): Promise<Seg[]> {
  let silero: Seg[] = [];
  try {
    silero = await sileroSegments(wav);
  } catch (e) {
    console.log(`  Silero FAILED -> ${e}（回退能量法）`);
  }
  return silero.length ? silero : energySegments(wav);
}

// ---------- 梯度判定 ----------
function verdict(rows: Row[]): void {
  console.log(
    '\n\n======== 三档梯度判定（accurate 应更全·更细，clean 应更干净）========',
  );
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.lang}/${r.variant}/${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let held = 0;
  let total = 0;
  for (const [k, grp] of groups) {
    const a = grp.find((r) => r.outcome === 'accurate');
    const c = grp.find((r) => r.outcome === 'clean');
    if (!a || !c) {
      console.log(`  ${k}: 缺档（需 accurate + clean），跳过`);
      continue;
    }
    total += 1;
    // 更全：accurate 字数 ≥ clean；更细：accurate 条数 ≥ clean。
    const fuller = a.chars >= c.chars;
    const finer = a.cues >= c.cues;
    // 更干净：clean 的静音幻觉与重复 ≤ accurate。
    const cleanerSilence = c.inSilence <= a.inSilence;
    const cleanerDup = c.dup <= a.dup;
    const ok = (fuller || finer) && cleanerSilence && cleanerDup;
    if (ok) held += 1;
    const mark = (b: boolean) => (b ? '✓' : '✗');
    console.log(
      `  ${k}: ${ok ? 'PASS' : 'WARN'}  ` +
        `更全 chars ${a.chars}→${c.chars} ${mark(fuller)} | ` +
        `更细 cues ${a.cues}→${c.cues} ${mark(finer)} | ` +
        `更干净 inSilence ${a.inSilence}→${c.inSilence} ${mark(
          cleanerSilence,
        )} · dup ${a.dup}→${c.dup} ${mark(cleanerDup)}`,
    );
  }
  console.log(
    `\n  结论：${held}/${total} 组呈现预期梯度（accurate→clean：更全/更细 且 更干净）。`,
  );
  console.log(
    '  说明：clean（纯语音）变体 inSilence 多为 0、对比弱属正常；music 变体最能体现「静音处不冒字」。',
  );
  console.log(
    '  这是真实音频的方向性证据（非硬断言）；WARN 表示该组某项未拉开差距，需人工看 SRT 核实。',
  );
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`addon: ${ADDON}`);
  console.log(`models dir: ${MODELS_DIR}`);
  console.log(
    `langs: ${LANGS.join(', ')}  models: ${MODELS.join(
      ', ',
    )}  variants: ${VARIANTS.join(', ')}  outcomes: ${OUTCOMES.join(', ')}`,
  );
  if (!fs.existsSync(ADDON)) {
    throw new Error(
      `whisper addon 缺失：${ADDON}（请先本地构建 / 放置 extraResources）`,
    );
  }
  if (!OUTCOMES.length) {
    throw new Error(
      'LONGGAP_OUTCOMES 未匹配任何档位（accurate/balanced/clean）',
    );
  }
  const whisper = loadWhisper();
  const fixtures = LONGGAP_FIXTURES.filter((f) => LANGS.includes(f.lang));
  if (!fixtures.length) {
    throw new Error(`LONGGAP_LANGS=${LANGS.join(',')} 未匹配任何 fixture`);
  }
  const rows: Row[] = [];
  for (const fix of fixtures) {
    console.log(
      `\n\n################ ${fix.label} (${fix.lang}) 设计静音≈${designedSilenceSeconds(
        fix,
      ).toFixed(0)}s ################`,
    );
    for (const variant of VARIANTS) {
      const wav = variant === 'music' ? musicWav(fix) : cleanWav(fix);
      const segments = await boundariesFor(wav);
      const totalSpeech = segments.reduce(
        (acc, s) => acc + (s.end - s.start),
        0,
      );
      const audioEnd = segments.reduce((acc, s) => Math.max(acc, s.end), 0);
      console.log(
        `\n==== ${variant}: ${segments.length} 语音段, speech≈${totalSpeech.toFixed(
          1,
        )}s, silence≈${(audioEnd - totalSpeech).toFixed(1)}s ====`,
      );
      for (const model of MODELS) {
        const modelFile = path.join(MODELS_DIR, `ggml-${model}.bin`);
        if (!fs.existsSync(modelFile)) {
          console.log(`#### ${model}: SKIP (missing ${modelFile})`);
          continue;
        }
        await runGroup(whisper, fix, variant, model, segments, rows);
      }
    }
  }
  verdict(rows);
  console.log(`\nSRT（tier-*）写入 ${OUT_DIR}`);
})().catch((e) => {
  console.error('longgap outcomes harness error:', e);
  process.exit(1);
});
