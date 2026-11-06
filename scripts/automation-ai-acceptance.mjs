import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import assert from 'node:assert/strict';

const profile =
  process.env.SMARTSUB_TEST_PROFILE || '/tmp/smartsub-automation-e2e-profile';
const output = path.resolve(
  process.env.SMARTSUB_AI_EVIDENCE || 'node_modules/.cache/automation-ai',
);
fs.mkdirSync(output, { recursive: true });
const executable = process.env.SMARTSUB_PACKAGED_APP || electron;
const dev = process.env.SMARTSUB_PACKAGED_APP ? '0' : '1';
const cli =
  process.env.SMARTSUB_PACKAGED_CLI || path.resolve('app/automation/cli.cjs');
const config = {
  command: executable,
  args: [cli, 'mcp', '--data-dir', profile],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    SMARTSUB_DEV: dev,
    SMARTSUB_APP_PATH: executable,
  },
};
fs.writeFileSync(
  path.join(output, 'mcp.json'),
  JSON.stringify({ mcpServers: { smartsub: config } }, null, 2),
);
const prompt = `Verify the SmartSub integration by actually using its tools. Do not modify source code or configuration. Use smartsub_system_sample to get the bundled audio path. Call smartsub_transcribe on that path using engine builtin, model tiny-q5_1, sourceLanguage en. Poll smartsub_tasks_wait until completed. Read its SRT with smartsub_subtitles_read. Convert the SRT to VTT using smartsub_subtitles_convert and poll until completed, then read the VTT. Finally use your shell tool to run this exact CLI command (a real media operation): ELECTRON_RUN_AS_NODE=1 SMARTSUB_DEV=${dev} SMARTSUB_APP_PATH=${JSON.stringify(executable)} ${JSON.stringify(executable)} ${JSON.stringify(cli)} media probe --file-path ${JSON.stringify(path.resolve('extraResources/sample-onboarding.mp3'))} --data-dir ${JSON.stringify(profile)} --json . Report JSON containing transcribeJobId, subtitlePath, vttPath, firstCueText, cliSucceeded. Do not simulate results. Use no paid media service.`;
const tools = [
  'system_sample',
  'transcribe',
  'tasks_wait',
  'tasks_get',
  'subtitles_read',
  'subtitles_convert',
];
async function run(client, args) {
  if (process.argv.includes('--verify-only')) return verify(client);
  const log = fs.openSync(path.join(output, `${client}.jsonl`), 'w');
  const errors = fs.openSync(path.join(output, `${client}.stderr.log`), 'w');
  const child = spawn(client, args, {
    stdio: ['ignore', log, errors],
    env: process.env,
  });
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill('SIGTERM');
    },
    Number(process.env.SMARTSUB_AI_TIMEOUT_MS || 900000),
  );
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timeout);
  fs.closeSync(log);
  fs.closeSync(errors);
  assert.equal(
    timedOut,
    false,
    `${client} acceptance timed out; inspect ${output}`,
  );
  assert.equal(code, 0, `${client} exited with ${code}; inspect ${output}`);
  verify(client);
}
function verify(client) {
  const events = fs
    .readFileSync(path.join(output, `${client}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const response =
    client === 'codex'
      ? events
          .filter(
            (e) =>
              e.type === 'item.completed' && e.item?.type === 'agent_message',
          )
          .map((e) => e.item.text)
          .at(-1)
      : events.at(-1)?.result;
  assert.ok(response, `${client} did not finish its report`);
  const candidates = [
    response,
    ...[...response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
      (match) => match[1],
    ),
  ];
  const report = candidates
    .map((candidate) => {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    })
    .find((value) => value?.transcribeJobId);
  assert.equal(report?.cliSucceeded, true, `${client} CLI did not succeed`);
  assert.ok(report.transcribeJobId && report.firstCueText);
  assert.match(fs.readFileSync(report.subtitlePath, 'utf8'), /-->/);
  assert.match(fs.readFileSync(report.vttPath, 'utf8'), /^WEBVTT/);
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(profile, 'automation/jobs', `${report.transcribeJobId}.json`),
      'utf8',
    ),
  );
  assert.equal(receipt.status, 'completed');
  fs.writeFileSync(
    path.join(output, `${client}.verified.json`),
    JSON.stringify(
      { client, ...report, verifiedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ client, success: true, evidence: output }));
}
const target = process.argv[2];
if (!target || target === 'codex')
  await run('codex', [
    'exec',
    '--ephemeral',
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `mcp_servers.smartsub=${JSON.stringify(config).replace(/"([^"\s]+)":/g, '$1 = ')}`,
    '-c',
    `mcp_servers.smartsub.enabled_tools=${JSON.stringify(tools.map((t) => `smartsub_${t}`))}`,
    '-c',
    'mcp_servers.smartsub.startup_timeout_sec=30',
    '-c',
    'mcp_servers.smartsub.tool_timeout_sec=90',
    ...tools.flatMap((t) => [
      '-c',
      `mcp_servers.smartsub.tools.smartsub_${t}.approval_mode="approve"`,
    ]),
    prompt,
  ]);
if (!target || target === 'claude')
  await run('claude', [
    '-p',
    prompt,
    '--mcp-config',
    path.join(output, 'mcp.json'),
    '--strict-mcp-config',
    '--allowedTools',
    ...tools.map((t) => `mcp__smartsub__smartsub_${t}`),
    'Bash',
    '--max-turns',
    '16',
    '--output-format',
    'json',
    '--no-session-persistence',
  ]);
