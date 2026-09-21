import { spawnSync } from 'node:child_process';

const scripts = [
  'test:launchpad-import',
  'test:proofread-reliability',
  'test:proofread-load',
  'test:proofread-waveform',
  'test:inline-ai',
  'test:glossary',
  'test:context-glossary',
  'test:subtitle-appearance',
  'test:compose-canvas',
  'test:compose-output',
  'test:compose-presets',
  'test:compose-queue',
  'test:embedded-fonts',
  'test:dubbing-speakers',
  'test:dubbing-ownership',
  'test:dubbing-config-draft',
  'test:dubbing-operations',
  'test:dubbing-auto-fit',
  'test:voice-preview',
  'test:navigation-save',
  'test:work-item-durability',
  'test:provider-health',
  'test:task-draft',
  'test:task-project',
  'test:task-readiness',
  'test:task-submission',
  'test:scenario-presets',
  'test:pipeline',
  'test:recipes',
  'test:toolbox',
  'test:video-download',
  'test:download-pipeline',
  'test:refine',
  'test:speaker-diarization',
  'test:manuscript',
];

for (const script of scripts) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', script],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Pro baseline: ${scripts.length} test commands passed.`);
