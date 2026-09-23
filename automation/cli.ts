import fs from 'node:fs';
import path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { operations, operationMap } from './catalog';
import { AutomationClient } from './client';
import { serveMcp } from './mcp';
import { safeMessage } from './redact';
import { setup } from './setup';

async function main() {
  const argv = process.argv.slice(2);
  const positionals: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [raw, ...parts] = arg.slice(2).split('=');
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['json', 'wait', 'help', 'install', 'overwrite'].includes(key)) {
      flags[key] = parts.length ? parts.join('=') !== 'false' : true;
      continue;
    }
    const value = parts.length ? parts.join('=') : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${raw}`);
    let parsed: any = value;
    try {
      parsed = JSON.parse(value);
    } catch {}
    flags[key] = parsed;
  }
  const client = new AutomationClient({
    dataDir: flags.dataDir,
    appPath: flags.appPath,
  });
  if (positionals[0] === 'mcp') {
    await serveMcp(client);
    return;
  }
  if (positionals[0] === 'setup') {
    console.log(JSON.stringify(await setup(positionals[1], flags), null, 2));
    return;
  }
  if (positionals[0] === 'doctor') positionals.splice(0, 1, 'system', 'info');
  let name = positionals[0] || '';
  if (!operationMap.has(name) && positionals[1]) name += `.${positionals[1]}`;
  if (positionals[0] === 'operations') {
    const selected =
      positionals[1] === 'describe'
        ? operationMap.get(positionals[2])
        : undefined;
    if (positionals[1] === 'describe' && !selected)
      throw new Error('UNKNOWN_OPERATION');
    console.log(
      JSON.stringify(
        selected
          ? {
              ...selected,
              schema: (zodToJsonSchema as Function)(selected.schema),
            }
          : operations.map(({ schema, ...op }) => op),
        null,
        2,
      ),
    );
    return;
  }
  const op = operationMap.get(name);
  if (flags.help || !name) {
    console.log(
      op
        ? `${op.description}\n${JSON.stringify((zodToJsonSchema as Function)(op.schema), null, 2)}`
        : `SmartSub CLI\n\nUsage: smartsub <group> <command> [--input-json file|-] [--json] [--wait]\n       smartsub transcribe --files '["/absolute/audio.mp3"]' --model tiny --wait\n       smartsub mcp\n       smartsub setup cli|mcp --client codex|claude [--install]\n\nCommands:\n${operations.map((o) => `  ${o.name.replace('.', ' ')}  ${o.description}`).join('\n')}`,
    );
    return;
  }
  if (!op) throw new Error(`UNKNOWN_OPERATION: ${name}`);
  let input: any = {};
  if (flags.inputJson)
    input = JSON.parse(
      fs.readFileSync(
        flags.inputJson === '-' ? 0 : path.resolve(flags.inputJson),
        'utf8',
      ),
    );
  const { json, wait, help, inputJson, dataDir, appPath, timeout, ...args } =
    flags;
  input = { ...input, ...args };
  const parsed = op.schema.parse(input);
  let result = await client.call(name, parsed);
  if (wait && result?.id && ['queued', 'running'].includes(result.status)) {
    const deadline = Date.now() + (Number(timeout) || 3600000);
    while (
      !['completed', 'failed', 'cancelled', 'interrupted', 'review'].includes(
        result.status,
      )
    ) {
      if (Date.now() >= deadline) {
        console.log(JSON.stringify(result, null, json ? undefined : 2));
        process.exitCode = 5;
        return;
      }
      result = await client.call('tasks.wait', {
        id: result.id,
        timeoutMs: Math.min(25000, Math.max(0, deadline - Date.now())),
      });
      if (!json) process.stderr.write(`${result.id}: ${result.status}\n`);
    }
  }
  console.log(JSON.stringify(result, null, json ? undefined : 2));
  if (['failed', 'interrupted'].includes(result?.status)) process.exitCode = 3;
  else if (result?.status === 'cancelled') process.exitCode = 130;
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error: {
        code: error.code || error.name,
        message: safeMessage(error.message),
      },
    }) + '\n',
  );
  process.exitCode =
    error.name === 'ZodError' ||
    /UNKNOWN_OPERATION|Missing value/.test(error.message)
      ? 2
      : /BACKEND_UNAVAILABLE|CONNECTION_LOST/.test(error.message)
        ? 4
        : 3;
});
