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
 * @property {'kokoro'|'vits'} modelType
 * @property {string} model        模型 onnx
 * @property {string} tokens       tokens.txt
 * @property {string} [voices]     kokoro voices.bin
 * @property {string} [lexicon]    词典（kokoro 多语可逗号并联多份）
 * @property {string} [dataDir]    espeak-ng-data 目录
 * @property {string} [dictDir]    jieba dict 目录（kokoro 中文）
 * @property {string} [ruleFsts]   数字/日期读法 fst（逗号并联）
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
 * @param {number|undefined} speed
 */
function clampSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(3, Math.max(0.5, s));
}

module.exports = { buildTtsConfig, buildTtsCacheKey, clampSpeed };
