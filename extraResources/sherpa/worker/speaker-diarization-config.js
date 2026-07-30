'use strict';

// 说话者分离配置纯函数。worker 与定向单测共同 require 本文件，避免原生参数
// 映射出现两份实现。零依赖，输入路径由主进程完成校验后传入。

/**
 * @typedef {Object} SpeakerDiarizationRequest
 * @property {string} segmentationModel
 * @property {string} embeddingModel
 * @property {number} [numClusters] 正数为已知说话者数；其它值使用自动聚类。
 * @property {number} [numThreads]
 */

/**
 * 构建 sherpa-onnx OfflineSpeakerDiarizationConfig。
 *
 * @param {SpeakerDiarizationRequest} req
 * @returns {object}
 */
function buildSpeakerDiarizationConfig(req) {
  const numThreads = Math.max(1, Math.min(8, Number(req.numThreads) || 2));
  const numClusters =
    Number.isInteger(req.numClusters) && req.numClusters > 0
      ? req.numClusters
      : -1;

  return {
    segmentation: {
      pyannote: { model: req.segmentationModel },
      numThreads,
      debug: 0,
      provider: 'cpu',
    },
    embedding: {
      model: req.embeddingModel,
      numThreads,
      debug: 0,
      provider: 'cpu',
    },
    clustering: {
      numClusters,
      threshold: 0.5,
    },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  };
}

module.exports = { buildSpeakerDiarizationConfig };
