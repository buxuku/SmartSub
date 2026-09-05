'use strict';
// TTS 模型配置纯函数：模型文件布局 → sherpa-onnx OfflineTtsConfig。
// 单一来源：tts-worker.js 与 test:dubbing 直接 require 本文件——
// 不重演 ASR 侧「sherpaConfig.ts 与 sherpa-worker.js 内联双份」的一致性隐患。
// 零依赖（无 fs / electron）：所有路径由调用方（catalog / PoC 脚本）拼好传入。

/**
 * TTS 模型加载请求（worker load/synthesize 消息共用的模型部分）。
 * 所有文件字段均为绝对路径；可选文件缺省即不传给 sherpa（空串跳过）。
 *
 * @typedef {Object} TtsModelRequest
 * @property {'kokoro'|'vits'|'zipvoice'} modelType
 * @property {string} [model]      模型 onnx（kokoro/vits）
 * @property {string} tokens       tokens.txt
 * @property {string} [voices]     kokoro voices.bin
 * @property {string} [lexicon]    词典（kokoro 多语可逗号并联多份）
 * @property {string} [dataDir]    espeak-ng-data 目录
 * @property {string} [dictDir]    jieba dict 目录（kokoro 中文）
 * @property {string} [ruleFsts]   数字/日期读法 fst（逗号并联）
 * @property {string} [encoder]    zipvoice encoder onnx
 * @property {string} [decoder]    zipvoice decoder onnx
 * @property {string} [vocoder]    zipvoice vocoder onnx（vocos，独立下载）
 * @property {number} [numThreads] 默认 2
 * @property {string} [provider]   默认 'cpu'
 */

/**
 * 构建 sherpa OfflineTts 构造配置。
 * speed 不在此处——它是 generate() 的逐次参数，不参与模型实例缓存。
 *
 * @param {TtsModelRequest} req
 * @returns {object} OfflineTtsConfig
 */
function buildTtsConfig(req) {
  const numThreads = req.numThreads > 0 ? req.numThreads : 2;
  const provider = req.provider || 'cpu';

  const model = {
    debug: 0,
    numThreads,
    provider,
  };

  if (req.modelType === 'kokoro') {
    model.kokoro = {
      model: req.model,
      voices: req.voices || '',
      tokens: req.tokens,
      dataDir: req.dataDir || '',
      dictDir: req.dictDir || '',
      lexicon: req.lexicon || '',
    };
  } else if (req.modelType === 'vits') {
    model.vits = {
      model: req.model,
      lexicon: req.lexicon || '',
      tokens: req.tokens,
      dataDir: req.dataDir || '',
      dictDir: req.dictDir || '',
    };
  } else if (req.modelType === 'zipvoice') {
    // 零样本克隆：模型 = encoder/decoder + 独立 vocoder；音色由 synthesize
    // 期的 generationConfig（参考音频 + 参考文本）驱动，无 sid 概念。
    model.zipvoice = {
      encoder: req.encoder,
      decoder: req.decoder,
      vocoder: req.vocoder,
      tokens: req.tokens,
      dataDir: req.dataDir || '',
      lexicon: req.lexicon || '',
    };
  } else {
    throw new Error(`unknown tts modelType: ${req.modelType}`);
  }

  const config = {
    model,
    // 逐条字幕合成：整段文本一次生成，不按句切分（时长测量以整段为准）。
    maxNumSentences: 1,
  };
  if (req.ruleFsts) config.ruleFsts = req.ruleFsts;
  return config;
}

/**
 * 模型实例缓存键：同键复用 OfflineTts 实例（加载秒级、切换才重建）。
 * @param {TtsModelRequest} req
 */
function buildTtsCacheKey(req) {
  return [
    req.modelType,
    req.model,
    req.encoder,
    req.decoder,
    req.vocoder,
    req.voices,
    req.tokens,
    req.lexicon,
    req.dataDir,
    req.dictDir,
    req.ruleFsts,
    req.numThreads,
    req.provider,
  ].join('|');
}

/**
 * speed 参数守卫：sherpa 各家模型 speed = 1/lengthScale，安全区间外钳制。
 * 对齐引擎红线 1.5x，但行级「接受变速」可放行到 2.0。
 * 克隆跨语言补偿会传入 <0.5 的值（如 0.6×0.7），下限放宽到 0.3。
 * @param {number|undefined} speed
 */
function clampSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(3, Math.max(0.3, s));
}

// ── 克隆合成的文本切块（内存安全约束）────────────────────────────────────────
// zipvoice 为 flow-matching 全序列生成：单块显存/内存随（参考+目标）帧数平方级
// 增长。字幕行常无标点（sherpa 内部按标点分句对其失效），超长块在 Electron 的
// PartitionAlloc 下触发 onnxruntime 大块分配 SIGTRAP（worker_threads 同进程，
// 直接带崩应用）。此处按「标点优先 + 硬上限兜底」切块，worker 逐块生成后拼接。

/** 单块上限：CJK 字符数 / 其他字符数（≈ 8s / 6s 音频 @ 0.6 speed）。 */
const CLONE_CHUNK_MAX_CJK = 20;
const CLONE_CHUNK_MAX_LATIN = 80;
/** 过短块并入前块的下限（避免一两个字的碎块吞音）。 */
const CLONE_CHUNK_MIN_CHARS = 4;

function isCjkChar(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** 文本权重：CJK 计 1，其他非空白计 0.25（对齐 20 CJK ≈ 80 latin 的上限比）。 */
function chunkWeight(text) {
  let w = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    w += isCjkChar(ch) ? 1 : 0.25;
  }
  return w;
}

/**
 * 克隆合成文本切块：先按句读标点切段，超上限的段按逗号/空格、硬上限逐级
 * 再切，相邻碎块合并到上限内。返回非空片段数组（原文无实义字符时返回 []）。
 * @param {string} text
 * @param {number} [maxWeight] 单块权重上限（参考音频越长应越小）
 * @returns {string[]}
 */
function splitCloneText(text, maxWeight = CLONE_CHUNK_MAX_CJK) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const limit = Math.max(CLONE_CHUNK_MIN_CHARS, maxWeight);

  // 一级：句读标点（保留在片段尾，朗读语气自然）。
  const primary = normalized.match(/[^。！？!?；;.…]+[。！？!?；;.…]*/g) || [
    normalized,
  ];

  // 二级：仍超上限的段按逗号/顿号/空格再切。
  const secondary = [];
  for (const seg of primary) {
    if (chunkWeight(seg) <= limit) {
      secondary.push(seg);
      continue;
    }
    const parts = seg.match(/[^，,、\s]+[，,、\s]*/g) || [seg];
    secondary.push(...parts);
  }

  // 三级：无标点长块按硬上限截断（字幕行常见）。
  const bounded = [];
  for (const seg of secondary) {
    if (chunkWeight(seg) <= limit) {
      bounded.push(seg);
      continue;
    }
    let piece = '';
    for (const ch of seg) {
      piece += ch;
      if (chunkWeight(piece) >= limit) {
        bounded.push(piece);
        piece = '';
      }
    }
    if (piece.trim()) bounded.push(piece);
  }

  // 合并：贪心拼相邻块到上限内（减少块数）。
  const merged = [];
  for (const seg of bounded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && chunkWeight(last) + chunkWeight(seg) <= limit) {
      merged[merged.length - 1] = last + seg;
    } else {
      merged.push(seg);
    }
  }
  // 尾块过短（一两个字易吞音）：并回前块（仅尾块容忍轻微超限）。
  if (
    merged.length >= 2 &&
    chunkWeight(merged[merged.length - 1]) < CLONE_CHUNK_MIN_CHARS
  ) {
    const tail = merged.pop();
    merged[merged.length - 1] += tail;
  }
  return merged.map((s) => s.trim()).filter(Boolean);
}

/**
 * 按参考音频时长收敛单块上限：参考越长,留给目标文本的序列预算越小
 * （总序列 = 参考帧 + 目标帧,内存平方级）。>10s 的存量参考减半。
 * @param {number} refSeconds
 */
function cloneChunkLimit(refSeconds) {
  return Number.isFinite(refSeconds) && refSeconds > 10
    ? Math.round(CLONE_CHUNK_MAX_CJK / 2)
    : CLONE_CHUNK_MAX_CJK;
}

// ── 中文数字归一化（克隆合成的文本前端）─────────────────────────────────────
// zipvoice 模型包不带 kokoro 那样的 number/date ruleFsts,阿拉伯数字会被
// espeak 前端按英文读出（"2020年" → "twenty twenty 年"）。中文占主导的文本
// 在送引擎前把数字转为汉字读法;参考文本同样处理（ASR 开 ITN 会产出数字,
// 与中文参考音频的发音错位会劣化克隆）。

const CN_DIGITS = '零一二三四五六七八九';
const CN_UNITS = ['', '十', '百', '千'];
const CN_SECTIONS = ['', '万', '亿', '万亿'];

/** 逐位读法（年份/超长数字串/小数部分）。 */
function digitByDigit(numStr) {
  let out = '';
  for (const ch of numStr) {
    const d = ch.charCodeAt(0) - 48;
    out += d >= 0 && d <= 9 ? CN_DIGITS[d] : ch;
  }
  return out;
}

/** 0–9999 段内读法。 */
function sectionToChinese(section) {
  let out = '';
  let zero = false;
  for (let unit = 3; unit >= 0; unit -= 1) {
    const d = Math.floor(section / Math.pow(10, unit)) % 10;
    if (d === 0) {
      if (out) zero = true;
    } else {
      if (zero) {
        out += '零';
        zero = false;
      }
      out += CN_DIGITS[d] + CN_UNITS[unit];
    }
  }
  return out;
}

/** 整数 → 中文读法（覆盖到万亿;10–19 按口语「十X」）。 */
function intToChinese(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return '零';
  const sections = [];
  let rest = n;
  while (rest > 0) {
    sections.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let out = '';
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const sec = sections[i];
    if (sec === 0) {
      if (out && !out.endsWith('零') && i > 0) out += '零';
      continue;
    }
    let text = sectionToChinese(sec);
    // 段间补零：如 1005 → 一千零五（低段不足 4 位时段首补零）。
    if (out && sec < 1000 && !out.endsWith('零')) out += '零';
    out += text + CN_SECTIONS[i];
  }
  // 口语惯例：10–19 开头的「一十」省成「十」。
  if (out.startsWith('一十')) out = out.slice(1);
  return out.replace(/零$/, '');
}

/**
 * Chinese speech input only. Explicit locale also covers numeric-only cues.
 * Without a locale, retain a conservative fallback for standalone worker clients.
 * @param {string} text
 * @param {string} [language]
 */
function normalizeChineseCloneText(text, language) {
  const raw = String(text || '');
  const locale = String(language || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  if (locale && locale !== 'auto' && locale !== 'zh') return raw;
  if (!locale || locale === 'auto') {
    const han = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (raw.match(/[a-z]/gi) || []).length;
    if (!han || han * 3 < latin || /[\u3040-\u30ff\uac00-\ud7af]/.test(raw))
      return raw;
  }

  // Match protected structures first, then whole numeric tokens. A malformed
  // separator sequence must not be partially converted by a later regex.
  const tokens =
    /https?:\/\/[^\s，。！？]+|[\w.+-]+@[\w.-]+\.[a-z]+|[a-z][a-z\d_.+-]*\d[a-z\d_.+-]*|[+-]?[\d０-９]+(?:[.,，．/：:\-][\d０-９]+)*(?:[%％])?/gi;
  return raw.replace(tokens, (token, offset) => {
    if (/[a-z@]/i.test(token)) return token;
    if (
      /[a-z_]/i.test(raw[offset - 1] || '') ||
      /^[a-z_]/i.test(raw.slice(offset + token.length))
    )
      return token;
    const value = token
      .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
      .replace(/，/g, ',')
      .replace(/．/g, '.')
      .replace(/％/g, '%');
    const after = raw.slice(offset + token.length);
    const before = raw.slice(Math.max(0, offset - 8), offset);
    // Versions/IP addresses, ranges, clocks and ambiguous slash dates remain intact.
    if (/(?:版本|version|\bv)\s*$/i.test(before)) return token;
    const date = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value);
    if (date) {
      const year = Number(date[1]),
        month = Number(date[3]),
        day = Number(date[4]);
      const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
        ? `${digitByDigit(date[1])}年${intToChinese(month)}月${intToChinese(day)}日`
        : token;
    }
    if (/^(?:0\d{2,3}-\d{7,8}|1[3-9]\d-\d{4}-\d{4})$/.test(value))
      return value.split('-').map(digitByDigit).join('，');
    if (/^\d{2,4}$/.test(value) && /^年/.test(after))
      return digitByDigit(value);
    const number = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?$/.exec(
      value,
    );
    if (!number) return token;
    const integer = number[2].replace(/,/g, '');
    const n = Number(integer);
    if (!Number.isSafeInteger(n)) return token;
    const digits =
      /^0\d/.test(integer) ||
      (integer.length >= 9 &&
        !number[2].includes(',') &&
        !number[3] &&
        !number[4]);
    const sign = number[1] === '-' ? '负' : number[1] === '+' ? '正' : '';
    const spoken =
      (digits ? digitByDigit(integer) : intToChinese(n)) +
      (number[3] ? `点${digitByDigit(number[3])}` : '');
    return sign + (number[4] ? '百分之' : '') + spoken;
  });
}

module.exports = {
  buildTtsConfig,
  buildTtsCacheKey,
  clampSpeed,
  splitCloneText,
  cloneChunkLimit,
  normalizeChineseCloneText,
  CLONE_CHUNK_MAX_CJK,
  CLONE_CHUNK_MAX_LATIN,
};
