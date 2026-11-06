import { build } from 'esbuild';
import fs from 'node:fs';

await build({
  entryPoints: ['automation/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'app/automation/cli.cjs',
  sourcemap: true,
});
fs.mkdirSync('app/automation', { recursive: true });
fs.writeFileSync(
  'app/automation/smartsub',
  `#!/bin/sh
SMARTSUB_LAUNCH_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "$SMARTSUB_APP_PATH" ]; then
  SMARTSUB_BIN="$SMARTSUB_APP_PATH"
elif [ -x "$SMARTSUB_LAUNCH_DIR/../../MacOS/SmartSub" ]; then
  SMARTSUB_BIN="$SMARTSUB_LAUNCH_DIR/../../MacOS/SmartSub"
else
  SMARTSUB_BIN="$SMARTSUB_LAUNCH_DIR/../../smartsub"
fi
ELECTRON_RUN_AS_NODE=1 exec "$SMARTSUB_BIN" "$SMARTSUB_LAUNCH_DIR/cli.cjs" "$@"
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  'app/automation/smartsub.cmd',
  '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nif defined SMARTSUB_APP_PATH (\r\n  "%SMARTSUB_APP_PATH%" "%~dp0cli.cjs" %*\r\n) else (\r\n  "%~dp0..\\..\\SmartSub.exe" "%~dp0cli.cjs" %*\r\n)\r\n',
);
console.error('Built SmartSub CLI and MCP entrypoints.');
