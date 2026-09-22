import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { synthesizeWithVolcengine } from '../../main/service/tts/volcengine';
import {
  createVolcTtsChunkParser,
  volcTtsPcmStream,
} from '../../main/service/tts/volcengineTtsUtils';
import { readWavInfo } from '../../main/helpers/dubbing/audioPipeline';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-volc-preview-'));
  const pcm = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=24000:duration=6',
    '-f',
    's16le',
    'pipe:1',
  ]);
  const done = JSON.stringify({
    code: 20000000,
    message: '完成 { } " \\',
    data: null,
  });
  const frame = (data: Buffer) =>
    JSON.stringify({ code: 0, data: data.toString('base64') });
  const bytes = Buffer.from(
    frame(pcm.subarray(0, 101)) +
      '\r\n' +
      frame(pcm.subarray(101, 1000)) +
      done,
  );
  const parser = createVolcTtsChunkParser(true);
  const parsed = [];
  for (const ch of bytes.toString('utf8')) parsed.push(...parser.push(ch));
  parser.finish();
  assert.equal(parsed.length, 3);
  const decode = async (text: Buffer, size = 7) => {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= text.length) controller.close();
        else {
          controller.enqueue(text.subarray(offset, (offset += size)));
        }
      },
    });
    const reader = volcTtsPcmStream(body).getReader();
    const output = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output.push(next.value);
    }
    return Buffer.concat(output);
  };
  assert.deepEqual(
    await decode(bytes, 1),
    pcm.subarray(0, 1000),
    'UTF-8, base64 and JSON split at every byte',
  );
  const largePcm = Buffer.alloc(1024 * 1024, 7);
  assert.deepEqual(
    await decode(Buffer.from(frame(largePcm) + done), 64000),
    largePcm,
  );
  assert.deepEqual(
    await decode(
      Buffer.from(
        JSON.stringify({
          code: 20000000,
          data: pcm.subarray(0, 100).toString('base64'),
        }),
      ),
    ),
    pcm.subarray(0, 100),
  );
  for (const [text, error] of [
    ['{"code":0,"data":"A?=="}', /base64/],
    ['{"code":0,}', /JSON/],
    ['{"code":0', /truncated/],
    [frame(pcm.subarray(0, 100)), /incomplete audio/],
    [frame(pcm.subarray(0, 101)) + done, /incomplete PCM/],
    ['{"data":"AAAA"}', /missing response code/],
    [
      '{"header":{"code":45000000,"message":"speaker permission denied"}}',
      /音色不可用/,
    ],
    [done + frame(pcm.subarray(0, 100)), /after completion/],
    ['{"code":0,"data":"' + 'A'.repeat(2 * 1024 * 1024), /exceeds/],
  ] as const) {
    await assert.rejects(decode(Buffer.from(text), 64000), error);
  }
  let mode = 'long',
    sentEnd = false,
    cancelled = 0;
  const received: { body: any; resource: string | string[] | undefined }[] = [];
  const server = http.createServer((request, response) => {
    const requestBytes: Buffer[] = [];
    request.on('data', (data) => requestBytes.push(data));
    request.on('end', () => {
      received.push({
        body: JSON.parse(Buffer.concat(requestBytes).toString()),
        resource: request.headers['x-api-resource-id'],
      });
      sentEnd = false;
      const current = mode;
      if (current === 'http') {
        response.writeHead(401);
        response.end(
          '{"header":{"code":45000010,"message":"Invalid X-Api-Key"}}',
        );
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (current === 'pending') {
        response.flushHeaders();
        response.on('close', () => cancelled++);
        return;
      }
      const audio = current === 'long' ? pcm : pcm.subarray(0, 24000);
      let offset = 0;
      const timer = setInterval(() => {
        if (offset < audio.length) {
          const json = Buffer.from(
            frame(audio.subarray(offset, (offset += 12001))) + '\n',
          );
          response.write(json.subarray(0, 17));
          response.write(json.subarray(17));
        } else {
          sentEnd = true;
          response.end(
            current === 'business'
              ? '{"code":45000000,"message":"speaker permission denied"}'
              : current === 'truncated'
                ? '{"code":20000'
                : done,
          );
          clearInterval(timer);
        }
      }, 30);
      response.on('close', () => {
        clearInterval(timer);
        if (!sentEnd) cancelled++;
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => originalFetch(base, init);
  const provider = {
    id: 'volc',
    name: 'volc',
    type: 'volcengine',
    apiKey: 'fixture',
    requestTimeoutSec: 5,
  };
  const output = path.join(root, 'sample.wav');
  const request = { text: 'Test', voice: 'S_fixture', outWavPath: output };
  try {
    let beforeEnd = false;
    const chunks: Buffer[] = [];
    const result = await synthesizeWithVolcengine(provider, {
      ...request,
      preview: {
        settings: { speed: 1, pitch: 12 },
        onPcm(data, rate) {
          beforeEnd ||= !sentEnd;
          chunks.push(Buffer.from(data));
          assert.equal(rate, 24000);
        },
      },
    });
    assert.ok(beforeEnd, 'first audio before HTTP completion');
    assert.equal(result.durationMs, 3000);
    assert.equal(Buffer.concat(chunks).length, 144000);
    assert.equal(readWavInfo(output).sampleRate, 24000);
    const data = Buffer.concat(chunks);
    let crossings = 0;
    for (let i = 2; i < data.length; i += 2)
      if (data.readInt16LE(i - 2) <= 0 && data.readInt16LE(i) > 0) crossings++;
    assert.ok(
      Math.abs(crossings / 3 - 880) < 5,
      'preview pitch settings applied',
    );
    fs.unlinkSync(output);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(cancelled > 0, 'three-second limit closes upstream HTTP');
    assert.equal(received[0].resource, 'seed-icl-2.0');
    assert.equal(received[0].body.req_params.audio_params.sample_rate, 24000);
    const abort = new AbortController();
    await assert.rejects(
      synthesizeWithVolcengine(provider, {
        ...request,
        signal: abort.signal,
        preview: { onPcm: () => abort.abort() },
      }),
      /TASK_CANCELLED/,
    );
    assert.equal(fs.existsSync(output), false);
    mode = 'pending';
    const waitingAbort = new AbortController();
    const waiting = synthesizeWithVolcengine(provider, {
      ...request,
      signal: waitingAbort.signal,
      preview: {
        onPcm() {
          throw new Error('cancelled wait must not emit audio');
        },
      },
    });
    const waitingFailure = assert.rejects(waiting, /TASK_CANCELLED/);
    const abortTimer = setTimeout(() => waitingAbort.abort(), 80);
    try {
      await waitingFailure;
    } finally {
      clearTimeout(abortTimer);
    }
    await assert.rejects(
      synthesizeWithVolcengine(
        { ...provider, requestTimeoutSec: 0.1 },
        {
          ...request,
          preview: {
            onPcm() {
              throw new Error('timed out wait must not emit audio');
            },
          },
        },
      ),
      /timeout|timed out|aborted/i,
    );
    assert.equal(fs.existsSync(output), false);
    for (const [next, error] of [
      ['business', /音色不可用/],
      ['truncated', /truncated/],
      ['http', /豆包语音|方舟/],
    ] as const) {
      mode = next;
      await assert.rejects(
        synthesizeWithVolcengine(provider, {
          ...request,
          preview: { onPcm() {} },
        }),
        error,
      );
      assert.equal(
        fs.existsSync(output),
        false,
        `${next} must not cache partial audio`,
      );
    }
    mode = 'short';
    const short = await synthesizeWithVolcengine(provider, {
      ...request,
      preview: { onPcm() {} },
    });
    assert.equal(short.durationMs, 500);
    fs.unlinkSync(output);
    const regular = await synthesizeWithVolcengine(provider, request);
    assert.equal(regular.durationMs, 500, 'regular synthesis remains intact');
    fs.unlinkSync(output);
    for (const [next, error] of [
      ['truncated', /truncated/],
      ['business', /音色不可用/],
    ] as const) {
      mode = next;
      await assert.rejects(synthesizeWithVolcengine(provider, request), error);
      assert.equal(
        fs.existsSync(output),
        false,
        'incomplete regular synthesis must not publish',
      );
    }
    console.log(
      JSON.stringify({
        root,
        checks:
          'JSON byte boundaries/UTF-8/escaped braces/base64/limits/errors, real slow HTTP PCM before EOF, 3s cap, pitch DSP, upstream close/cancel, no failed cache, regular synthesis',
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
