const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-edge-preview-'));
const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
const mp3 = execFileSync(require('ffmpeg-static'), [
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
let metadataResolve;
let deferMetadata = false;
let streamCalls = 0;
let closed = 0;
Module._load = function (request, parent, isMain) {
  if (request === 'msedge-tts')
    return {
      OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' },
      MsEdgeTTS: class {
        async setMetadata() {
          if (deferMetadata)
            await new Promise((resolve) => {
              metadataResolve = resolve;
            });
        }
        async toStream() {
          streamCalls++;
          return { audioStream: Readable.from([mp3]) };
        }
        close() {
          closed++;
        }
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};
async function main() {
  const { synthesizeWithEdge } = require('../../main/service/tts/edge.ts');
  const provider = { id: 'edge', type: 'edge', requestTimeoutSec: 5 };
  const outWavPath = path.join(root, 'sample.wav');
  let received = 0;
  const result = await synthesizeWithEdge(provider, {
    text: 'Hello',
    voice: 'en-US-AriaNeural',
    outWavPath,
    preview: {
      onPcm: (pcm) => {
        received += pcm.length;
      },
    },
  });
  assert.equal(result.durationMs, 3000);
  assert.equal(received, 144000);
  assert.equal(closed, 1);
  fs.unlinkSync(outWavPath);
  const abort = new AbortController();
  await assert.rejects(
    synthesizeWithEdge(provider, {
      text: 'Hello',
      voice: 'en-US-AriaNeural',
      outWavPath,
      signal: abort.signal,
      preview: { onPcm: () => abort.abort() },
    }),
    /TASK_CANCELLED/,
  );
  assert.equal(fs.existsSync(outWavPath), false);
  deferMetadata = true;
  const pendingAbort = new AbortController();
  const pending = synthesizeWithEdge(provider, {
    text: 'Hello',
    voice: 'en-US-AriaNeural',
    outWavPath,
    signal: pendingAbort.signal,
    preview: {
      onPcm() {
        throw new Error('must not emit');
      },
    },
  });
  const rejected = assert.rejects(pending, /TASK_CANCELLED/);
  const before = streamCalls;
  pendingAbort.abort();
  metadataResolve();
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    streamCalls,
    before,
    'cancelled metadata wait does not open a stream later',
  );
  assert.equal(fs.existsSync(outWavPath), false);
  fs.rmdirSync(root);
  console.log(
    'Edge preview: real MP3 decode, 3-second PCM, cancellation during decoding and metadata await, connection cleanup passed (SDK transport fixture).',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    require.extensions['.ts'] = originalTs;
  });
