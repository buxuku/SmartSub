'use strict';

const assert = require('node:assert/strict');
const {
  buildSpeakerDiarizationConfig,
} = require('../extraResources/sherpa/worker/speaker-diarization-config.js');

const automatic = buildSpeakerDiarizationConfig({
  segmentationModel: 'segmentation.onnx',
  embeddingModel: 'embedding.onnx',
});
assert.equal(automatic.clustering.numClusters, -1);
assert.equal(automatic.segmentation.numThreads, 2);
assert.equal(automatic.embedding.numThreads, 2);
assert.equal(automatic.segmentation.pyannote.model, 'segmentation.onnx');
assert.equal(automatic.embedding.model, 'embedding.onnx');

const known = buildSpeakerDiarizationConfig({
  segmentationModel: 'segmentation.onnx',
  embeddingModel: 'embedding.onnx',
  numClusters: 4,
  numThreads: 99,
});
assert.equal(known.clustering.numClusters, 4);
assert.equal(known.segmentation.numThreads, 8);
assert.equal(known.embedding.numThreads, 8);
assert.equal(known.clustering.threshold, 0.5);

console.log('✓ speaker diarization config tests passed (10)');
