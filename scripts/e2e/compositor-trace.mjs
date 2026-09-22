import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const statistics = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
    over25Ms: sorted.filter((value) => value > 25).length,
  };
};

// Chromium can report several pipelines for one display interval. Preserve
// those raw states separately; never turn their sum into a dropped-frame rate.
// Only completed FrameSequenceTrackerV3 sequences carry Chromium's expected /
// dropped counts. Missing/incomplete counters must not be read as zero drops.
export function summarizeCompositorTrace(trace) {
  const events = trace.traceEvents;
  if (!Array.isArray(events)) throw new Error('Missing traceEvents');
  const marks = new Map(
    events
      .filter((event) => event.name?.startsWith('smartsub:'))
      .map((event) => [event.name, event]),
  );
  const pending = new Map();
  const sequences = [];
  for (const event of events) {
    if (event.name !== 'FrameSequenceTrackerV3') continue;
    const key = JSON.stringify([event.pid, event.scope, event.id2, event.id]);
    if (event.ph === 'b') pending.set(key, event);
    if (event.ph === 'e' && pending.has(key)) {
      const begin = pending.get(key);
      sequences.push({ begin, end: event });
      pending.delete(key);
    }
  }
  const phases = {};
  for (const [name, start] of marks) {
    if (!name.endsWith(':start')) continue;
    const phase = name.slice('smartsub:'.length, -':start'.length);
    const end = marks.get(`smartsub:${phase}:end`);
    if (!end || end.pid !== start.pid || end.ts <= start.ts)
      throw new Error(`Missing or invalid end marker for ${phase}`);
    const inPhase = (event) => event.ts >= start.ts && event.ts < end.ts;
    const renderer = events.filter(
      (event) => event.pid === start.pid && inPhase(event),
    );
    const pipelines = {};
    let missingContentReports = 0;
    for (const event of renderer) {
      if (event.name !== 'PipelineReporter' || event.ph !== 'b') continue;
      const reporter = event.args?.chrome_frame_reporter;
      if (!reporter) continue;
      pipelines[reporter.state] = (pipelines[reporter.state] || 0) + 1;
      if (reporter.has_missing_content) missingContentReports++;
    }
    const presented = [
      ...new Set(
        events
          .filter(
            (event) =>
              event.name === 'Display::FrameDisplayed' && inPhase(event),
          )
          .map((event) => event.ts),
      ),
    ].sort((a, b) => a - b);
    const intervals = presented
      .slice(1)
      .map((time, index) => (time - presented[index]) / 1000);
    const trackers = sequences
      .filter(
        ({ begin, end: finish }) =>
          begin.pid === start.pid && inPhase(begin) && finish.ts <= end.ts,
      )
      .map(({ begin, end: finish }) => ({
        type: begin.args?.name,
        durationMs: (finish.ts - begin.ts) / 1000,
        counters: begin.args?.args?.data ?? finish.args?.args?.data ?? null,
      }));
    const unaccountedSequences = [
      ...sequences
        .filter(
          ({ begin, end: finish }) =>
            begin.pid === start.pid && inPhase(begin) && finish.ts > end.ts,
        )
        .map(({ begin }) => begin),
      ...pending.values(),
    ].filter((begin) => begin.pid === start.pid && inPhase(begin)).length;
    phases[phase] = {
      durationMs: (end.ts - start.ts) / 1000,
      presentedFrames: presented.length,
      presentation: intervals.length
        ? {
            averageFps:
              (intervals.length * 1000) / intervals.reduce((a, b) => a + b, 0),
            ...statistics(intervals),
          }
        : null,
      mainFrameWork: statistics(
        renderer
          .filter(
            (event) =>
              event.tid === start.tid &&
              event.name === 'ProxyMain::BeginMainFrame' &&
              event.ph === 'X' &&
              Number.isFinite(event.dur),
          )
          .map((event) => event.dur / 1000),
      ),
      pipelineReports: pipelines,
      missingContentReports,
      trackers,
      unaccountedSequences,
    };
  }
  if (!Object.keys(phases).length)
    throw new Error('Missing SmartSub phase markers');
  return { phases };
}

export function hasCompleteSmoothWheelEvidence(summary, phase) {
  const entry = summary.phases[phase];
  const trackers = entry?.trackers.filter(
    (tracker) => tracker.type === 'WheelScroll',
  );
  return (
    !!entry &&
    entry.unaccountedSequences === 0 &&
    entry.missingContentReports === 0 &&
    trackers.length > 0 &&
    trackers.every(
      ({ counters }) =>
        Number.isInteger(counters?.expected) &&
        counters.expected > 0 &&
        counters.dropped === 0 &&
        counters.missing_content === 0,
    )
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const file = process.argv[2];
  if (!file)
    throw new Error('Usage: node scripts/e2e/compositor-trace.mjs TRACE.json');
  console.log(
    JSON.stringify(
      summarizeCompositorTrace(JSON.parse(await fs.readFile(file, 'utf8'))),
      null,
      2,
    ),
  );
}
