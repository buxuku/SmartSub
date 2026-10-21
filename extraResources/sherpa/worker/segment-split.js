'use strict';
// 超长 VAD 段的硬切分（openspec split-qwen-asr-long-segments，design D2）。
// 纯函数、无依赖，只返回样本区间、不拷贝样本；由 sherpa-worker.js 用 subarray 取片。
// 与 wav-io.js 同目录，worker 以 require(path.join(__dirname, ...)) 加载（不经 webpack）。
// 不做 instanceof 检查：测试里它会被另一个 vm 上下文的 Float32Array 调用。

/** 能量分析的帧长（秒）。 */
const FRAME_SECONDS = 0.02;
/** 切点搜索半径的上界（秒）。 */
const MAX_SEARCH_SECONDS = 2;
/** 小于它的上限视为无效：TS 侧取值不小于 1 秒，更短的值只可能是误配置。 */
const MIN_LIMIT_SECONDS = 1;

/** 逐帧均方能量，再做三帧平滑；两端的帧只平均存在的邻居。 */
function smoothedFrameEnergy(samples, frameLen) {
  const frames = Math.floor(samples.length / frameLen);
  const raw = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const base = f * frameLen;
    let sum = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = samples[base + i];
      sum += x * x;
    }
    raw[f] = sum / frameLen;
  }
  const smooth = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const lo = f > 0 ? f - 1 : f;
    const hi = f < frames - 1 ? f + 1 : f;
    let sum = 0;
    for (let g = lo; g <= hi; g += 1) sum += raw[g];
    smooth[f] = sum / (hi - lo + 1);
  }
  return smooth;
}

/**
 * 把超过上限的段切成首尾相接的几片，切点取理想等分位置附近能量最低的帧。
 *
 * - 上限缺省、非有限、小于 1 秒，或段不超过上限：返回整段一片。
 * - r = min(2 秒, L / 6)，n = ceil(d / (L − 2r))，第 k 个理想切点是 k·d/n。
 *   每片最长 d/n + 2r ≤ L，是构造出来的；r ≤ L/6 保证相邻搜索窗口不相交，切点次序不会颠倒。
 * - 窗口内能量并列时取离理想位置最近的帧，所以平坦信号退化成等分。
 *
 * @param {ArrayLike<number>} samples 单声道样本
 * @param {number} sampleRate
 * @param {number} maxSeconds 每片的上限（秒）
 * @returns {Array<{ start: number, end: number }>} 样本区间 [start, end)，相对于 samples
 */
function splitSegment(samples, sampleRate, maxSeconds) {
  const total = samples.length;
  const whole = [{ start: 0, end: total }];
  if (!(sampleRate > 0)) return whole;
  if (!Number.isFinite(maxSeconds) || maxSeconds < MIN_LIMIT_SECONDS) {
    return whole;
  }
  const maxLen = Math.floor(maxSeconds * sampleRate);
  if (total <= maxLen) return whole;

  const radius = Math.min(
    Math.floor(MAX_SEARCH_SECONDS * sampleRate),
    Math.floor(maxLen / 6),
  );
  const count = Math.ceil(total / (maxLen - 2 * radius));
  const frameLen = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const half = Math.floor(frameLen / 2);
  const energy = smoothedFrameEnergy(samples, frameLen);
  const lastFrame = energy.length - 1;

  const cuts = [0];
  for (let k = 1; k < count; k += 1) {
    const ideal = (k * total) / count;
    const distance = (f) => Math.abs(f * frameLen + half - ideal);
    // 以离理想位置最近的帧为起点，窗口内只有严格更安静、或同样安静但更近的帧才替换它
    let best = Math.min(
      lastFrame,
      Math.max(0, Math.round((ideal - half) / frameLen)),
    );
    const from = Math.max(0, Math.ceil((ideal - radius - half) / frameLen));
    const to = Math.min(
      lastFrame,
      Math.floor((ideal + radius - half) / frameLen),
    );
    for (let f = from; f <= to; f += 1) {
      if (
        energy[f] < energy[best] ||
        (energy[f] === energy[best] && distance(f) < distance(best))
      ) {
        best = f;
      }
    }
    cuts.push(best * frameLen + half);
  }
  cuts.push(total);
  return cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1] }));
}

module.exports = { splitSegment };
