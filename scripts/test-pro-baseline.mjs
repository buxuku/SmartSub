import { spawnSync } from 'node:child_process';

const scripts = [
  'test:launchpad-import',
  'test:proofread-reliability',
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
