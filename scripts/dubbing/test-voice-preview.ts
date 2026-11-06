import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VoicePreviewCache,
  previewCloneIdentity,
} from '../../main/helpers/dubbing/voicePreviewCache';
import { TaskCancelledError } from '../../main/helpers/taskContext';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { synthesizeWithOpenAiCompatible } from '../../main/service/tts/openaiCompatible';
import { synthesizeWithAzure } from '../../main/service/tts/azure';
import { synthesizeWithElevenLabs } from '../../main/service/tts/elevenlabs';
import { readWavInfo } from '../../main/helpers/dubbing/audioPipeline';

async function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-preview-cache-'),
  );
  let calls = 0;
  const create = async () => {
    const wavPath = path.join(root, `sample-${++calls}.wav`);
    fs.writeFileSync(wavPath, 'fixture');
    return { wavPath, durationMs: 3000 };
  };
  const cache = new VoicePreviewCache(2, 60_000);
  const identity = {
    provider: { id: 'p', model: 'm', apiKey: 'test' },
    voice: 'one',
    speed: 1,
    pitch: 0,
  };
  const first = await cache.get(1, 'one', identity, create);
  assert.deepEqual(await cache.get(1, 'hit', identity, create), first);
  assert.equal(calls, 1);
  const second = await cache.get(
    1,
    'two',
    { ...identity, voice: 'two' },
    create,
  );
  await cache.get(1, 'touch', identity, create);
  await cache.get(1, 'three', { ...identity, pitch: 2 }, create);
  assert.equal(fs.existsSync(first.wavPath), true, 'LRU hit is retained');
  assert.equal(
    fs.existsSync(second.wavPath),
    false,
    'LRU eviction removes the audio file',
  );
  const otherWindow = await cache.get(2, 'one', identity, create);
  assert.notEqual(
    otherWindow.wavPath,
    first.wavPath,
    'no cross-window ownership',
  );
  cache.dispose(1);
  assert.equal(fs.existsSync(first.wavPath), false);
  assert.equal(fs.existsSync(otherWindow.wavPath), true);

  for (const changed of [
    { ...identity, provider: { ...identity.provider, apiKey: 'changed' } },
    { ...identity, provider: { ...identity.provider, model: 'new-model' } },
    { ...identity, speed: 1.5 },
    { ...identity, text: 'another sample' },
  ]) {
    const before = calls;
    await cache.get(2, 'changed', changed, create);
    assert.equal(calls, before + 1);
  }
  const missing = await cache.get(3, 'missing', identity, create);
  fs.unlinkSync(missing.wavPath);
  assert.notEqual(
    (await cache.get(3, 'missing-again', identity, create)).wavPath,
    missing.wavPath,
  );
  const expiredCache = new VoicePreviewCache(2, 0);
  const expired = await expiredCache.get(4, 'expires', identity, create);
  assert.notEqual(
    (await expiredCache.get(4, 'expired', identity, create)).wavPath,
    expired.wavPath,
  );
  assert.equal(fs.existsSync(expired.wavPath), false);
  expiredCache.dispose(4);

  for (const action of ['cancel', 'dispose', 'replace'] as const) {
    let finish!: (preview: Awaited<ReturnType<typeof create>>) => void;
    let signal!: AbortSignal;
    const pending = cache.get(5, 'pending', identity, (value) => {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const rejected = assert.rejects(pending, TaskCancelledError);
    cache.cancel(5, 'different-request');
    cache.cancel(6, 'pending');
    assert.equal(signal.aborted, false, 'unrelated cancellation is ignored');
    if (action === 'cancel') cache.cancel(5, 'pending');
    if (action === 'dispose') cache.dispose(5);
    if (action === 'replace')
      await cache.get(5, 'newer', { voice: 'two' }, create);
    assert.equal(signal.aborted, true);
    const late = await create();
    finish(late);
    await rejected;
    assert.equal(
      fs.existsSync(late.wavPath),
      false,
      'uncancellable late generation is removed',
    );
    cache.dispose(5);
  }
  await assert.rejects(cache.get(9, '', identity, create), /Invalid preview/);
  await assert.rejects(
    cache.get(9, 'failure', identity, async () => {
      throw new Error('provider failed');
    }),
    /provider failed/,
  );
  assert.ok(await cache.get(9, 'retry', identity, create));

  const reference = path.join(root, 'ref.wav');
  fs.writeFileSync(reference, 'old reference');
  const clone = {
    id: 'cv_one',
    engine: 'zipvoice' as const,
    language: 'en' as const,
    name: 'Clone',
    refWavPath: reference,
    refText: 'Hello',
    createdAt: 1,
  };
  const before = previewCloneIdentity(clone);
  fs.writeFileSync(reference, 'new reference bytes');
  assert.notDeepEqual(previewCloneIdentity(clone), before);
  assert.notDeepEqual(
    previewCloneIdentity({ ...clone, refText: 'Changed' }),
    previewCloneIdentity(clone),
  );
  fs.unlinkSync(reference);
  assert.notDeepEqual(previewCloneIdentity(clone), before);
  for (const owner of [2, 3, 9]) cache.dispose(owner);
  assert.deepEqual(
    fs.readdirSync(root),
    [],
    'all preview artifacts are bounded and disposed',
  );
  const wav = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=24000:duration=6',
    '-f',
    'wav',
    '-c:a',
    'pcm_s16le',
    'pipe:1',
  ]);
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=24000:duration=6',
    '-f',
    's16le',
    '-c:a',
    'pcm_s16le',
    'pipe:1',
  ]);
  const mp3 = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=24000:duration=6',
    '-f',
    'mp3',
    'pipe:1',
  ]);
  let sentEnd = false;
  let aborted = 0;
  let responseBytes = wav;
  const urls: string[] = [];
  const server = http.createServer((request, response) => {
    urls.push(request.url!);
    request.resume();
    request.on('end', () => {
      sentEnd = false;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= responseBytes.length) {
          sentEnd = true;
          response.end();
          clearInterval(timer);
        } else {
          response.write(responseBytes.subarray(offset, offset + 12000));
          offset += 12000;
        }
      }, 50);
      response.on('close', () => {
        if (!sentEnd) aborted++;
        clearInterval(timer);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    for (const [name, synthesize, bytes] of [
      ['openai', synthesizeWithOpenAiCompatible, wav],
      ['azure', synthesizeWithAzure, wav],
      ['elevenlabs', synthesizeWithElevenLabs, pcm],
      ['mp3-fallback', synthesizeWithOpenAiCompatible, mp3],
    ] as const) {
      responseBytes = bytes;
      const streamed: Uint8Array[] = [];
      let beforeEnd = false;
      const result = await synthesize(
        {
          id: name,
          name,
          type: name,
          apiKey: 'test',
          apiUrl: base,
          endpoint: base,
        },
        {
          text: 'Test',
          voice: 'voice',
          outWavPath: path.join(root, `${name}.wav`),
          preview: {
            settings: { speed: 1, pitch: 12 },
            onPcm: (chunk, rate) => {
              beforeEnd ||= !sentEnd;
              assert.equal(rate, 24000);
              streamed.push(chunk);
            },
          },
        },
      );
      assert.ok(beforeEnd, `${name} delivers audio before response ends`);
      assert.equal(result.durationMs, 3000);
      const decoded = readWavInfo(result.wavPath);
      assert.equal(decoded.sampleRate, 24000);
      assert.equal(Buffer.concat(streamed).length, 24000 * 2 * 3);
      const samples = Buffer.concat(streamed);
      let crossings = 0;
      for (let i = 4801; i < 67200; i++)
        if (
          samples.readInt16LE((i - 1) * 2) <= 0 &&
          samples.readInt16LE(i * 2) > 0
        )
          crossings++;
      assert.ok(
        Math.abs((crossings * 24000) / (67200 - 4800) - 880) < 5,
        `${name} preserves role pitch`,
      );
      fs.unlinkSync(result.wavPath);
    }
    assert.ok(
      urls.some((url) => url.includes('/text-to-speech/voice/stream?')),
    );
    responseBytes = wav;
    const controller = new AbortController();
    const cancelledPath = path.join(root, 'cancelled.wav');
    await assert.rejects(
      synthesizeWithOpenAiCompatible(
        {
          id: 'p',
          name: 'P',
          type: 'openaiCompatible',
          apiKey: 'test',
          apiUrl: base,
        },
        {
          text: 'Test',
          voice: 'voice',
          outWavPath: cancelledPath,
          signal: controller.signal,
          preview: { onPcm: () => controller.abort() },
        },
      ),
      TaskCancelledError,
    );
    assert.equal(fs.existsSync(cancelledPath), false);
    assert.ok(aborted > 0, 'bounded preview closes provider response early');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmdirSync(root);
  console.log(
    'Voice preview: cache LRU/TTL/ownership/cancellation/identity/cleanup; incremental HTTP WAV/MP3/raw PCM before EOF, role DSP, 3-second cap, upstream cancellation and stream endpoint passed.',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
