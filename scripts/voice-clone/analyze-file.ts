/** 诊断:对指定媒体跑 analyze,打印语音段/建议/质检与能量概览。 */
import path from 'path';
import {
  analyzeCloneSource,
  disposeCloneAnalysisSession,
  inspectCloneRange,
} from '../../main/helpers/voiceClone/cloneAudioPipeline';
import { CLONE_TARGET_RANGES } from '../../types/voiceClone';

async function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: analyze-file <media>');
    process.exit(1);
  }
  const outDir = path.join(
    process.cwd(),
    'node_modules/.cache/voice-clone-poc',
  );
  const session = await analyzeCloneSource(src, 'zipvoice', {
    tempDir: outDir,
  });
  console.log(`duration=${(session.durationMs / 1000).toFixed(1)}s`);
  console.log(`segments=${session.segments.length}`);
  for (const s of session.segments.slice(0, 20)) {
    console.log(
      `  ${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)}s (${((s.endMs - s.startMs) / 1000).toFixed(1)}s)`,
    );
  }
  console.log('suggestion =', session.suggestion);
  if (session.suggestion) {
    const report = inspectCloneRange(
      session,
      session.suggestion.startMs,
      session.suggestion.endMs,
      CLONE_TARGET_RANGES.zipvoice,
    );
    console.log('suggested range report =', JSON.stringify(report));
  }
  // 能量概览:每 10s 的语音帧均值 dB。
  const f = session.frames;
  const win = Math.round(10000 / f.frameMs);
  const rows: string[] = [];
  for (let i = 0; i < f.frameDb.length; i += win) {
    const slice = f.frameDb.slice(i, i + win);
    const energy =
      slice.reduce((a, v) => a + Math.pow(10, v / 10), 0) / slice.length;
    rows.push(
      `${((i * f.frameMs) / 1000).toFixed(0)}s: ${(10 * Math.log10(energy)).toFixed(1)}dB`,
    );
  }
  console.log('每 10s 能量:', rows.join('  '));
  // 整文件质检(全选区)。
  const full = inspectCloneRange(
    session,
    0,
    session.durationMs,
    CLONE_TARGET_RANGES.zipvoice,
  );
  console.log(
    `full-range: speech=${(full.speechMs / 1000).toFixed(1)}s ratio=${full.speechRatio} rms=${full.rmsDb}dB peak=${full.peakDb}dB snr=${full.snrDb}dB`,
  );
  disposeCloneAnalysisSession(session.id);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
