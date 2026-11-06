import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeCompositorTrace,
  hasCompleteSmoothWheelEvidence,
} from './compositor-trace.mjs';

const fixture = (
  counters = { expected: 180, dropped: 0, missing_content: 0 },
) => ({
  traceEvents: [
    { name: 'smartsub:wheelDiff:start', pid: 1, tid: 2, ts: 0 },
    {
      name: 'FrameSequenceTrackerV3',
      ph: 'b',
      pid: 1,
      id2: { local: '1' },
      ts: 1,
      args: { name: 'WheelScroll', args: { data: counters } },
    },
    {
      name: 'FrameSequenceTrackerV3',
      ph: 'e',
      pid: 9,
      id2: { local: '1' },
      ts: 2,
    },
    {
      name: 'PipelineReporter',
      ph: 'b',
      pid: 1,
      ts: 2,
      args: { chrome_frame_reporter: { state: 'STATE_PRESENTED_ALL' } },
    },
    {
      name: 'PipelineReporter',
      ph: 'b',
      pid: 1,
      ts: 2,
      args: { chrome_frame_reporter: { state: 'STATE_PRESENTED_PARTIAL' } },
    },
    { name: 'Display::FrameDisplayed', pid: 3, ts: 1000 },
    { name: 'Display::FrameDisplayed', pid: 3, ts: 17667 },
    { name: 'Display::FrameDisplayed', pid: 3, ts: 34334 },
    {
      name: 'ProxyMain::BeginMainFrame',
      ph: 'X',
      pid: 1,
      tid: 2,
      ts: 3000,
      dur: 4500,
    },
    {
      name: 'FrameSequenceTrackerV3',
      ph: 'e',
      pid: 1,
      id2: { local: '1' },
      ts: 49000,
    },
    { name: 'smartsub:wheelDiff:end', pid: 1, tid: 2, ts: 50000 },
  ],
});

test('uses display intervals and Chromium counters without double-counting pipeline reports', () => {
  const result = summarizeCompositorTrace(fixture());
  const phase = result.phases.wheelDiff;
  assert.equal(phase.presentedFrames, 3);
  assert.ok(Math.abs(phase.presentation.averageFps - 60) < 0.01);
  assert.equal(phase.mainFrameWork.maxMs, 4.5);
  assert.equal(phase.trackers[0].durationMs, 48.999);
  assert.equal(phase.pipelineReports.STATE_PRESENTED_PARTIAL, 1);
  assert.equal(hasCompleteSmoothWheelEvidence(result, 'wheelDiff'), true);
});

test('missing counters, real drops, missing content and unfinished sequences never pass', () => {
  for (const counters of [
    null,
    {},
    { expected: 0, dropped: 0, missing_content: 0 },
    { expected: 180, dropped: 1, missing_content: 0 },
    { expected: 180, dropped: 0, missing_content: 1 },
  ]) {
    assert.equal(
      hasCompleteSmoothWheelEvidence(
        summarizeCompositorTrace(fixture(counters)),
        'wheelDiff',
      ),
      false,
    );
  }
  const unfinished = fixture();
  unfinished.traceEvents = unfinished.traceEvents.filter(
    (event) => !(event.ph === 'e' && event.pid === 1),
  );
  assert.equal(
    hasCompleteSmoothWheelEvidence(
      summarizeCompositorTrace(unfinished),
      'wheelDiff',
    ),
    false,
  );
  assert.equal(
    hasCompleteSmoothWheelEvidence(
      summarizeCompositorTrace(fixture()),
      'missing',
    ),
    false,
  );
});

test('rejects absent or unmatched phase markers', () => {
  assert.throws(() => summarizeCompositorTrace({ traceEvents: [] }), /Missing/);
  const broken = fixture();
  broken.traceEvents.pop();
  assert.throws(() => summarizeCompositorTrace(broken), /end marker/);
});
