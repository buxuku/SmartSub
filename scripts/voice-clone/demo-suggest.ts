/** 用真实管线算 demo.mp4 的推荐选区（复现用户创建路径）。 */
import path from 'path';
import {
  analyzeCloneSource,
  disposeCloneAnalysisSession,
  inspectCloneRange,
  prepareCloneReference,
} from '../../main/helpers/voiceClone/cloneAudioPipeline';
import { CLONE_TARGET_RANGES } from '../../types/voiceClone';

async function main() {
  const root = process.cwd();
  const outDir = path.join(root, 'node_modules/.cache/voice-clone-poc');
  const session = await analyzeCloneSource(
    '/Users/xiaodong/Downloads/translate/demo.mp4',
    'zipvoice',
    { tempDir: outDir },
  );
  console.log(
    `duration=${session.durationMs}ms segments=${session.segments.length}`,
  );
  console.log('suggestion =', session.suggestion);
  if (session.suggestion) {
    const report = inspectCloneRange(
      session,
      session.suggestion.startMs,
      session.suggestion.endMs,
      CLONE_TARGET_RANGES.zipvoice,
    );
    console.log('report =', JSON.stringify(report));
    const { refWavPath } = await prepareCloneReference(
      session,
      session.suggestion.startMs,
      session.suggestion.endMs,
      CLONE_TARGET_RANGES.zipvoice,
      path.join(outDir, 'demo-suggested-ref.wav'),
    );
    console.log('ref =', refWavPath);
  }
  disposeCloneAnalysisSession(session.id);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
