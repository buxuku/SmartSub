import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import electron from 'electron';
import http from 'node:http';
import ffmpeg from 'ffmpeg-static';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-automation-'));
const profile = path.join(root, 'profile');
const evidence = [];
const executable = process.env.SMARTSUB_PACKAGED_APP || electron;
const cli =
  process.env.SMARTSUB_PACKAGED_CLI || path.resolve('app/automation/cli.cjs');
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  SMARTSUB_DEV: process.env.SMARTSUB_PACKAGED_APP ? '0' : '1',
  SMARTSUB_APP_PATH: executable,
};
let client, transport;
let wave,
  delaySpeech = false;
let failSpeech = false;
const aiRequests = [];
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(req.url);
  if (req.url === '/v1/audio/transcriptions')
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        text: 'Hello fixture.',
        language: 'en',
        duration: 3,
        segments: [{ id: 0, start: 0, end: 2, text: 'Hello fixture.' }],
      }),
    );
  else if (req.url === '/v1/audio/speech') {
    if (failSpeech) {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({ error: { message: 'fixture synthesis failure' } }),
        );
    } else if (delaySpeech) {
      const timer = setTimeout(() => res.end(wave), 10000);
      res.on('close', () => clearTimeout(timer));
    } else res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wave);
  } else if (req.url === '/v1/chat/completions') {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    aiRequests.push(body);
    const content = body.messages.at(-1).content;
    let translated = '你好。';
    try {
      const obj = JSON.parse(content);
      translated = JSON.stringify(
        Object.fromEntries(Object.keys(obj).map((k) => [k, '你好。'])),
      );
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        id: 'fixture',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: translated },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  } else res.writeHead(404).end();
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${mock.address().port}/v1`;

async function connect() {
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--data-dir', profile],
    env,
    stderr: 'pipe',
  });
  client = new Client({ name: 'smartsub-e2e', version: '1' });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({
    name: `smartsub_${name.replace(/[.-]/g, '_')}`,
    arguments: args,
  });
  if (result.isError)
    throw new Error(result.content.map((c) => c.text || '').join('\n'));
  assert.ok(result.structuredContent);
  return result.structuredContent.result;
}
async function done(job) {
  while (
    !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
  )
    job = await call('tasks.wait', { id: job.id, timeoutMs: 25000 });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return job;
}
const stopBackend = () => {
  try {
    const endpoint = JSON.parse(
      fs.readFileSync(path.join(profile, 'automation/endpoint.json'), 'utf8'),
    );
    process.kill(endpoint.pid, 'SIGTERM');
  } catch {}
};
try {
  await connect();
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 100);
  assert.equal(
    new Set(tools.tools.map((t) => t.name)).size,
    tools.tools.length,
  );
  evidence.push('MCP handshake and schemas');
  const info = await call('system.info');
  assert.equal(info.profile, profile);
  assert.equal(info.background, true);
  assert.ok(info.storageTopology?.userData);
  assert.ok(info.storageTopology?.pyEnginesRoot);
  assert.ok(info.engineRuntimes?.fasterWhisper?.engineDir);
  assert.ok(info.engineRuntimes?.fasterWhisper?.pythonExecutable);
  assert.equal(info.engineRuntimes?.fasterWhisper?.requiresExternalPython, false);
  assert.ok(info.engineRuntimes?.sherpaOnnx);
  assert.ok(info.hardwareEnvironment?.platform);
  assert.ok(info.architectureNotes?.qualityRules?.includes('CPS'));
  assert.ok(info.architectureNotes?.storageRule);
  evidence.push('cold start without BrowserWindow');
  await call('settings.update', {
    settings: {
      proxyMode: 'system',
      proxyUrl: 'http://alice:privatepass@127.0.0.1:6553',
    },
  });
  const settings = await call('settings.get');
  assert.ok(!JSON.stringify(settings).includes('privatepass'));
  assert.ok(!JSON.stringify(settings).includes('alice'));
  await call('settings.update', { settings: { proxyUrl: '' } });
  const endpoint = JSON.parse(
    fs.readFileSync(path.join(profile, 'automation/endpoint.json'), 'utf8'),
  );
  const health = `http://127.0.0.1:${endpoint.port}/health`;
  assert.equal((await fetch(health)).status, 401);
  assert.equal(
    (
      await fetch(health, {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          Origin: 'https://example.org',
        },
      })
    ).status,
    401,
  );
  evidence.push('loopback authentication and browser origin rejection');
  const file = path.join(root, '字幕 with spaces.srt');
  const literal = 'The password: example is shown. Bearer trees are nearby.';
  const literalPath = path.join(root, 'Bearer trees sk-fictionalword.srt');
  await call('subtitles.write', {
    filePath: literalPath,
    cues: [{ startMs: 0, endMs: 1000, text: literal }],
  });
  const literalRead = await call('subtitles.read', { filePath: literalPath });
  assert.equal(literalRead.filePath, literalPath);
  assert.equal(literalRead.cues[0].text, literal);
  await call('subtitles.write', {
    filePath: literalPath,
    cues: literalRead.cues,
    overwrite: true,
    expectedVersion: literalRead.version,
  });
  assert.ok(fs.readFileSync(literalPath, 'utf8').includes(literal));
  evidence.push(
    'URL credentials hidden and literal subtitle/path content preserved through MCP read-write',
  );
  const cues = [
    { startMs: 0, endMs: 1000, text: 'Hello 世界' },
    { startMs: 1100, endMs: 2200, text: 'Second line' },
  ];
  await call('subtitles.write', { filePath: file, cues });
  const read = await call('subtitles.read', {
    filePath: file,
    offset: 1,
    limit: 1,
  });
  assert.equal(read.total, 2);
  assert.equal(read.cues[0].text, 'Second line');
  await assert.rejects(
    call('subtitles.write', { filePath: file, cues }),
    /OUTPUT_EXISTS/,
  );
  await assert.rejects(
    call('subtitles.write', {
      filePath: file,
      cues,
      overwrite: true,
      expectedVersion: 'stale',
    }),
    /EDIT_CONFLICT/,
  );
  await call('subtitles.write', {
    filePath: file,
    cues,
    overwrite: true,
    expectedVersion: read.version,
  });
  const converted = await call('subtitles.convert', {
    filePath: file,
    targetFormat: 'vtt',
    requestId: 'convert-once',
  });
  const duplicate = await call('subtitles.convert', {
    filePath: file,
    targetFormat: 'vtt',
    requestId: 'convert-once',
  });
  assert.equal(duplicate.id, converted.id);
  await assert.rejects(
    call('subtitles.convert', {
      filePath: file,
      targetFormat: 'ass',
      requestId: 'convert-once',
    }),
    /REQUEST_CONFLICT/,
  );
  const convertedDone = await done(converted);
  assert.match(
    fs.readFileSync(convertedDone.result.outputPath, 'utf8'),
    /^WEBVTT/,
  );
  evidence.push(
    'Unicode paths, cue pagination, atomic edits, collision protection, persistent deduplication and conversion',
  );
  await call('providers.save', {
    kind: 'tts',
    provider: {
      id: 'edge-test',
      name: 'Edge test',
      type: 'edge',
      voices: 'en-US-AriaNeural',
      apiKey: 'secret-never-echo',
    },
  });
  const providers = await call('providers.list', { kind: 'tts' });
  assert.equal(
    providers.tts.find((p) => p.id === 'edge-test').configured,
    true,
  );
  assert.ok(!JSON.stringify(providers).includes('secret-never-echo'));
  assert.ok(
    (await call('tts.voices', { providerId: 'edge-test' })).voices.some(
      (v) => v.id === 'en-US-AriaNeural',
    ),
  );
  await call('providers.save', {
    kind: 'tts',
    provider: { id: 'edge-test', name: 'Changed', type: 'edge' },
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'))
      .ttsProviders[0].apiKey,
    'secret-never-echo',
  );
  evidence.push('write-only secrets and credential-preserving patches');
  const glossary = (
    await call('glossaries.create', { name: 'Automation glossary' })
  ).data;
  assert.ok(glossary?.id);
  const exported = path.join(root, 'glossary.csv');
  await call('glossaries.export', {
    glossaryId: glossary.id,
    format: 'csv',
    outputPath: exported,
  });
  assert.ok(fs.existsSync(exported));
  await call('glossaries.delete', { id: glossary.id });
  const video = path.join(root, 'video.mp4');
  const generated = spawnSync(
    ffmpeg,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:r=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      video,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const probe = await call('media.probe', { filePath: video });
  assert.ok(probe.duration >= 2.9);
  const extracted = await done(
    await call('media.extract-audio', {
      filePath: video,
      config: { format: 'wav', wavPreset: 'asr_16k_mono' },
    }),
  );
  assert.ok(fs.statSync(extracted.result.outputPath).size > 1000);
  assert.equal(extracted.progress.channel, 'toolbox:audioProgress');
  const composed = await done(
    await call('compose.run', {
      videoPath: video,
      subtitlePath: file,
      outputPath: path.join(root, 'subtitled.mkv'),
      config: {
        outputMode: 'softmux',
        videoQuality: 'original',
        encoderMode: 'cpu',
      },
    }),
  );
  assert.ok(fs.statSync(composed.result.data).size > 1000);
  assert.ok(
    ['compose:queue', 'subtitleMerge:progress'].includes(
      composed.progress.channel,
    ),
  );
  evidence.push('real FFmpeg probe, audio extraction and subtitle mux');
  const dub = await call('dubbing.create', { subtitlePath: file });
  assert.ok(dub.data.sessionId);
  const session = await call('dubbing.get', { sessionId: dub.data.sessionId });
  assert.equal(session.data.cues.length, 2);
  evidence.push('persistent dubbing session without renderer');
  wave = fs.readFileSync(extracted.result.outputPath);
  await call('providers.save', {
    kind: 'tts',
    provider: {
      id: 'mock-tts',
      name: 'Local fixture',
      type: 'openaiCompatible',
      apiKey: 'fixture',
      apiUrl,
      model: 'fixture',
      voices: 'alloy',
    },
  });
  const speech = await done(
    await call('tts.synthesize', {
      providerId: 'mock-tts',
      voice: 'alloy',
      text: 'Hello',
    }),
  );
  assert.ok(fs.statSync(speech.result.wavPath).size > 1000);
  const dubConfig = {
    engine: { kind: 'cloud', providerId: 'mock-tts' },
    voice: 'alloy',
    globalSpeed: 1,
    background: 'mute',
    output: 'audioOnly',
    audioFormat: 'wav',
  };
  // A short fixture keeps cue synthesis inside the explicit time slots.
  const shortWave = path.join(root, 'short.wav');
  assert.equal(
    spawnSync(ffmpeg, [
      '-v',
      'error',
      '-i',
      extracted.result.outputPath,
      '-t',
      '0.3',
      shortWave,
    ]).status,
    0,
  );
  wave = fs.readFileSync(shortWave);
  const edit = {
    index: 0,
    startMs: 0,
    endMs: 1000,
    baseText: cues[0].text,
    text: 'Revised text',
  };
  await call('dubbing.edit', { sessionId: dub.data.sessionId, edits: [edit] });
  await assert.rejects(
    call('dubbing.edit', {
      sessionId: dub.data.sessionId,
      edits: [{ ...edit, baseText: 'stale', text: 'bad' }],
    }),
    /changed/,
  );
  const synth = await done(
    await call('dubbing.run', {
      sessionId: dub.data.sessionId,
      config: dubConfig,
    }),
  );
  assert.equal(synth.result.data.doneCount, 2);
  const dubExport = await done(
    await call('dubbing.export', {
      sessionId: dub.data.sessionId,
      config: dubConfig,
    }),
  );
  assert.ok(fs.statSync(dubExport.result.data.outputPath).size > 1000);
  failSpeech = true;
  // Let the local fixture server run while the actual CLI waits for failure.
  const cliFailure = await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        cli,
        'dubbing',
        'run',
        '--session-id',
        dub.data.sessionId,
        '--config',
        JSON.stringify(dubConfig),
        '--force',
        'true',
        '--wait',
        '--json',
        '--data-dir',
        profile,
      ],
      { env },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(cliFailure.code, 3, cliFailure.stderr);
  const failedDub = JSON.parse(cliFailure.stdout);
  assert.equal(failedDub.status, 'failed');
  assert.equal(failedDub.error.code, 'DUBBING_CUES_FAILED');
  assert.equal(failedDub.result.data.failedIndexes.length, 2);
  evidence.push(
    'failed dubbing cues retain batch result and make waiting CLI exit 3',
  );
  failSpeech = false;
  delaySpeech = true;
  const cancelling = await call('tts.synthesize', {
    providerId: 'mock-tts',
    voice: 'alloy',
    text: 'Cancel this',
  });
  await new Promise((r) => setTimeout(r, 300));
  await call('tasks.cancel', { id: cancelling.id });
  assert.equal(
    (await call('tasks.wait', { id: cancelling.id, timeoutMs: 25000 })).status,
    'cancelled',
  );
  delaySpeech = false;
  evidence.push(
    'local mock TTS, cue edit conflict, synthesis, audio export and request cancellation',
  );
  await call('providers.save', {
    kind: 'asr',
    provider: {
      id: 'mock-asr',
      name: 'Local ASR fixture',
      type: 'openaiCompatible',
      apiKey: 'fixture',
      apiUrl,
      models: 'fixture',
    },
  });
  const rejectedRefinement = await call('transcribe', {
    files: [video],
    engine: 'cloud',
    providerId: 'mock-asr',
    model: 'fixture',
    config: {
      aiSegmentation: true,
      preserveSpeechPauses: true,
      refineProvider: 'missing-ai',
    },
  });
  const refinementFailure = await call('tasks.wait', {
    id: rejectedRefinement.id,
    timeoutMs: 25000,
  });
  assert.equal(refinementFailure.status, 'failed');
  assert.equal(refinementFailure.error.code, 'REFINE_PROVIDER_REQUIRED');
  assert.match(refinementFailure.error.message, /providers.list/);
  assert.equal(refinementFailure.projectId, undefined);
  assert.deepEqual(refinementFailure.artifacts, []);
  const invalidTranslation = await call('translate', {
    files: [video],
    targetLanguage: 'zh',
    providerId: '-1',
  });
  const translationFailure = await call('tasks.wait', {
    id: invalidTranslation.id,
    timeoutMs: 25000,
  });
  assert.equal(translationFailure.error.code, 'SUBTITLE_INPUT_REQUIRED');
  evidence.push(
    'real MCP rejects unresolved refinement and wrong translation input before processing',
  );
  const pipeline = await call('pipeline.run', {
    files: [video],
    taskType: 'generateOnly',
    engine: 'cloud',
    providerId: 'mock-asr',
    model: 'fixture',
    sourceLanguage: 'en',
    config: {
      asrProviderId: 'mock-asr',
      compose: { subtitle: 'soft' },
      gates: { subtitle: 'manual', dubbing: 'auto' },
      useEmbeddedSubtitles: false,
    },
  });
  let reviewed = await call('tasks.wait', {
    id: pipeline.id,
    timeoutMs: 25000,
  });
  assert.equal(reviewed.status, 'review', JSON.stringify(reviewed));
  await call('pipeline.release', { projectId: pipeline.id, gate: 'subtitle' });
  const released = await done(await call('tasks.get', { id: pipeline.id }));
  assert.equal(released.id, pipeline.id);
  assert.ok(
    released.artifacts.some((a) => a.kind === 'mkv' || a.kind === 'mp4'),
  );
  const proofFile = released.artifacts.find((a) => a.kind === 'json').path;
  const proof = await call('proofread.read', { filePath: proofFile });
  await assert.rejects(
    call('proofread.save', {
      filePath: proofFile,
      expectedVersion: 'stale',
      subtitles: proof.subtitles,
      speakers: proof.speakers,
    }),
    /EDIT_CONFLICT/,
  );
  await call('proofread.save', {
    filePath: proofFile,
    expectedVersion: proof.version,
    subtitles: proof.subtitles,
    speakers: proof.speakers,
  });
  await call('providers.save', {
    kind: 'translation',
    provider: {
      id: 'mock-ai',
      name: 'Local AI fixture',
      type: 'openai',
      isAi: true,
      apiKey: 'fixture',
      apiUrl,
      modelName: 'fixture',
      prompt: '${content}',
      requestInterval: 0,
    },
  });
  const optimized = await done(
    await call('subtitles.optimize', {
      sourceText: 'Hello',
      targetText: '你好',
      providerId: 'mock-ai',
      mode: 'translation',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    }),
  );
  assert.ok(optimized.result);
  await done(
    await call('subtitles.optimize', {
      sourceText: 'English transcription.',
      providerId: 'mock-ai',
      mode: 'source',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    }),
  );
  assert.match(JSON.stringify(aiRequests.at(-1).messages), /Do not translate/);
  assert.doesNotMatch(
    JSON.stringify(aiRequests.at(-1).messages),
    /Please translate to/,
  );
  evidence.push(
    'source optimization sends original-language correction prompt',
  );
  evidence.push(
    'local mock ASR and AI, manual review release resumes original job, canonical proofread version checking',
  );
  const concurrent = await Promise.all([
    call('system.info'),
    call('tasks.get', { id: pipeline.id }),
    call('subtitles.read', { filePath: file }),
  ]);
  assert.equal(concurrent[2].total, 2);
  await assert.rejects(
    call('subtitles.read', { filePath: 'relative.srt' }),
    /Absolute/,
  );
  assert.ok(
    requests.includes('/v1/audio/transcriptions') &&
      requests.includes('/v1/audio/speech') &&
      requests.includes('/v1/chat/completions'),
  );

  await client.close();
  await connect();
  const durable = await call('tasks.get', { id: converted.id });
  assert.equal(durable.status, 'completed');
  evidence.push('MCP reconnect preserves results');
  const raw = spawnSync(
    executable,
    [
      cli,
      'media',
      'probe',
      '--file-path',
      video,
      '--data-dir',
      profile,
      '--json',
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(JSON.parse(raw.stdout).width, 320);
  evidence.push('CLI JSON contains no backend/native logs');
  const invalid = await client.callTool({
    name: 'smartsub_media_probe',
    arguments: {},
  });
  assert.equal(invalid.isError, true);
  evidence.push('invalid input is an MCP tool error');
  stopBackend();
  await new Promise((r) => setTimeout(r, 700));
  await client.close();
  await connect();
  assert.equal(
    (await call('tasks.get', { id: converted.id })).status,
    'completed',
  );
  assert.equal(
    (
      await call('subtitles.convert', {
        filePath: file,
        targetFormat: 'vtt',
        requestId: 'convert-once',
      })
    ).id,
    converted.id,
  );
  evidence.push('backend restart retains receipts and deduplication');
  const interrupted = {
    id: 'interrupted-test',
    operation: 'transcribe',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    artifacts: [],
    actions: [],
    projectId: 'missing',
  };
  stopBackend();
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(
    path.join(profile, 'automation/jobs/interrupted-test.json'),
    JSON.stringify(interrupted),
  );
  await client.close();
  await connect();
  assert.equal(
    (await call('tasks.get', { id: 'interrupted-test' })).status,
    'interrupted',
  );
  evidence.push('unfinished jobs become interrupted after restart');
  console.log(
    JSON.stringify(
      { success: true, root, operations: tools.tools.length, checks: evidence },
      null,
      2,
    ),
  );
} finally {
  mock.closeAllConnections();
  mock.close();
  await client?.close().catch(() => {});
  stopBackend();
  fs.writeFileSync(
    path.join(root, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
}
