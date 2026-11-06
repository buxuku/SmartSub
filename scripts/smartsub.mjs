import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
const child = spawn(
  electron,
  [path.resolve('app/automation/cli.cjs'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SMARTSUB_DEV: '1',
      SMARTSUB_APP_PATH: electron,
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
