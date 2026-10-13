/**
 * 主侧 sherpa 运行时的"静默失败变明确错误"接线测试。
 *
 * 真实现场（GitHub Actions windows-latest，路径含中文）：VAD 构造函数不抛错，只在 stderr 写
 * `... Silero vad model file '...' does not exist` 与 `Errors in config`，随后每次使用打印一行
 * `vad is nullptr`，请求以 0 个语音段「成功」结束。运行时要把这种结果转成带原因的错误，
 * 并释放带着空句柄的 worker（否则缓存的空 VAD 会让之后每个请求都静默失败）。
 *
 * 这里用假的 utilityProcess 宿主驱动真实的 sherpaFunasrRuntime.ts（electron / store / 宿主用桩替换）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const runtimeFile = path.join(
  repoRoot,
  'main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts',
);

const originalLoad = Module._load;
const originalTs = require.extensions['.ts'];

const fixture = {
  hosts: [],
  logs: [],
  language: 'en',
  /** 暂存桩：映射表里有的路径视为暂存成功，其余原样返回（等同暂存失败回落） */
  staged: new Map(),
};

class FakeHost {
  constructor(options) {
    this.options = options;
    this.posted = [];
    this.messageListeners = [];
    this.exitListeners = [];
    this.killed = false;
  }
  onMessage(listener) {
    this.messageListeners.push(listener);
  }
  onExit(listener) {
    this.exitListeners.push(listener);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  kill() {
    this.killed = true;
    queueMicrotask(() =>
      this.exitListeners.forEach((listener) =>
        listener({
          code: 0,
          killedByUs: true,
          classification: {},
          stderrTail: '',
        }),
      ),
    );
  }
  /** worker 发来的消息 */
  emit(message) {
    this.messageListeners.forEach((listener) => listener(message));
  }
  /** worker 写到 stderr 的一行 */
  stderr(line) {
    this.options.onStderrLine?.(line);
  }
  lastRequest() {
    return this.posted[this.posted.length - 1];
  }
}

require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => 'C:\\Users\\张三\\AppData\\Roaming\\SmartSub' },
    };
  }
  if (parent?.filename === runtimeFile) {
    switch (request) {
      case '../storeManager':
        return {
          logMessage: (message, level) =>
            fixture.logs.push({ message: String(message), level }),
          store: {
            get: (key) =>
              key === 'settings' ? { language: fixture.language } : undefined,
          },
        };
      case '../utils':
        return { getExtraResourcesPath: () => '/app/resources' };
      case './sherpaLibPaths':
        return {
          getSherpaLibDir: () => '/lib/sherpa',
          isSherpaLibInstalled: () => true,
        };
      case './nativeSafePath':
        return {
          ensureNativeSafeModelPath: (file) => fixture.staged.get(file) ?? file,
        };
      case '../crash/appUtilityHost':
        return {
          spawnAppUtilityHost: (options) => {
            const host = new FakeHost(options);
            fixture.hosts.push(host);
            return host;
          },
        };
      case '../crash/crashContext':
        return { beginCrashContext: () => () => {} };
      case '../crash/utilityHost':
        return {
          buildSherpaWorkerEnv: () => ({}),
          describeHostExit: () => 'exit',
        };
      default:
        break;
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// 真实 Windows 现场逐字摘录（路径里的中文用户名就是 CI 里的 `中文用户-测试`）
const WIN_REASON =
  "D:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\csrc\\silero-vad-model-config.cc:Validate:60 Silero vad model file 'D:\\a\\_temp\\smartsub\\中文用户-测试\\silero_vad.onnx' does not exist";
const WIN_GENERIC =
  'D:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\c-api\\c-api.cc:SherpaOnnxCreateVoiceActivityDetector:1330 Errors in config';
const REASON_TEXT =
  "Silero vad model file 'D:\\a\\_temp\\smartsub\\中文用户-测试\\silero_vad.onnx' does not exist";

const CJK_VAD = 'C:\\Users\\张三\\AppData\\Local\\SmartSub\\silero_vad.onnx';
const ASCII_VAD =
  'C:\\ProgramData\\SmartSub\\native-safe\\abc\\silero_vad.onnx';
const CJK_ASR = 'D:\\模型\\sense-voice\\model.onnx';

const VAD_PARAMS = {
  vad_threshold: 0.5,
  vad_min_speech_duration_ms: 200,
  vad_min_silence_duration_ms: 300,
  vad_max_speech_duration_s: 0,
};

function senseVoiceModel(overrides = {}) {
  return {
    vadModel: CJK_VAD,
    modelType: 'sense_voice',
    asrModel: 'D:\\models\\sense-voice\\model.onnx',
    tokens: 'D:\\models\\sense-voice\\tokens.txt',
    params: { provider: 'cpu', num_threads: 2 },
    ...overrides,
  };
}

function freshRuntime() {
  delete require.cache[runtimeFile];
  fixture.hosts.length = 0;
  fixture.logs.length = 0;
  fixture.staged.clear();
  fixture.language = 'en';
  return require(runtimeFile).getSherpaFunasrRuntime();
}

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NULL_LINES = 40;

function failVadOnWorker(host) {
  host.stderr(WIN_REASON);
  host.stderr(WIN_GENERIC);
  for (let i = 0; i < NULL_LINES; i++) host.stderr('vad is nullptr');
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

async function main() {
  await test('transcribe：stderr 先到，零语音段 + `vad is nullptr` → 带原因的错误并释放 worker', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host = fixture.hosts[0];
    failVadOnWorker(host);
    host.emit({ type: 'done', id, segments: [], vadSegments: [] });
    const error = await rejection(result);
    assert.match(
      error.message,
      /^The local voice activity detection \(VAD\) model failed to load/,
    );
    assert.ok(error.message.includes(REASON_TEXT), error.message);
    assert.equal(
      host.killed,
      true,
      'the worker holding the null VAD is released',
    );
    assert.ok(
      fixture.logs.some(
        (l) => l.level === 'error' && l.message.includes(REASON_TEXT),
      ),
      'the native reason is logged at error level',
    );
  });

  await test('transcribe：中文界面用中文文案', async () => {
    const runtime = freshRuntime();
    fixture.language = 'zh';
    const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host = fixture.hosts[0];
    failVadOnWorker(host);
    host.emit({ type: 'done', id, segments: [], vadSegments: [] });
    const error = await rejection(result);
    assert.ok(
      error.message.startsWith('本地语音活动检测（VAD）模型加载失败'),
      error.message,
    );
  });

  await test('竞态：done 比 stderr 先到也能识别（等待 stderr 排空）', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host = fixture.hosts[0];
    host.emit({ type: 'done', id, segments: [], vadSegments: [] });
    await sleep(40);
    failVadOnWorker(host);
    const error = await rejection(result);
    assert.ok(error.message.includes(REASON_TEXT), error.message);
  });

  await test('真正的静音（零语音段，没有 `vad is nullptr`）照常成功，worker 不释放', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.transcribe(senseVoiceModel(), 'silence.wav');
    const host = fixture.hosts[0];
    host.emit({ type: 'done', id, segments: [], vadSegments: [] });
    assert.deepEqual(await result, { segments: [], vadSegments: [] });
    assert.equal(host.killed, false);
  });

  await test('有识别结果就不是静默失败（即使 stderr 里出现过 `vad is nullptr`）', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host = fixture.hosts[0];
    host.stderr('vad is nullptr');
    const segments = [{ start: 0, end: 1, text: 'hello' }];
    host.emit({
      type: 'done',
      id,
      segments,
      vadSegments: [{ start: 0, end: 1 }],
    });
    assert.deepEqual((await result).segments, segments);
    assert.equal(host.killed, false);
  });

  await test('只看本次请求开始之后新增的 `vad is nullptr`：之前的不连累后面的静音文件', async () => {
    const runtime = freshRuntime();
    const first = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host = fixture.hosts[0];
    host.stderr('vad is nullptr');
    host.stderr('vad is nullptr');
    host.emit({
      type: 'done',
      id: first.id,
      segments: [{ start: 0, end: 1, text: 'x' }],
      vadSegments: [],
    });
    await first.result;
    const second = runtime.transcribe(senseVoiceModel(), 'b.wav');
    host.emit({ type: 'done', id: second.id, segments: [], vadSegments: [] });
    assert.deepEqual(await second.result, { segments: [], vadSegments: [] });
    assert.equal(host.killed, false);
  });

  await test('detectSpeech：同样把静默的空 VAD 变成错误', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.detectSpeech('a.wav', CJK_VAD, VAD_PARAMS);
    const host = fixture.hosts[0];
    failVadOnWorker(host);
    host.emit({ type: 'done', id, segments: [] });
    const error = await rejection(result);
    assert.ok(error.message.includes(REASON_TEXT), error.message);
    assert.equal(host.killed, true);
  });

  await test('detectSpeech：真正的静音照常返回空数组', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.detectSpeech('a.wav', CJK_VAD, VAD_PARAMS);
    fixture.hosts[0].emit({ type: 'done', id, segments: [] });
    assert.deepEqual((await result).segments, []);
  });

  await test('失败后 worker 被释放：下一次请求重建 worker，且不继承旧的计数', async () => {
    const runtime = freshRuntime();
    const first = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const firstHost = fixture.hosts[0];
    failVadOnWorker(firstHost);
    firstHost.emit({
      type: 'done',
      id: first.id,
      segments: [],
      vadSegments: [],
    });
    await rejection(first.result);
    await sleep(5);
    const second = runtime.transcribe(senseVoiceModel(), 'b.wav');
    assert.equal(fixture.hosts.length, 2, 'a new worker is spawned');
    fixture.hosts[1].emit({
      type: 'done',
      id: second.id,
      segments: [],
      vadSegments: [],
    });
    assert.deepEqual(await second.result, { segments: [], vadSegments: [] });
  });

  await test('等待 stderr 排空期间 worker 已被替换：照样报错，但不误杀新 worker', async () => {
    const runtime = freshRuntime();
    const a = runtime.transcribe(senseVoiceModel(), 'a.wav');
    const host1 = fixture.hosts[0];
    failVadOnWorker(host1);
    host1.emit({ type: 'done', id: a.id, segments: [], vadSegments: [] });
    runtime.dispose(); // 等待期间别处释放了这个 worker
    await sleep(5);
    const b = runtime.transcribe(senseVoiceModel(), 'b.wav');
    const host2 = fixture.hosts[1];
    assert.ok(host2, 'a new worker serves the next request');
    const error = await rejection(a.result);
    assert.ok(error.message.includes(REASON_TEXT), error.message);
    assert.equal(host2.killed, false, 'the rebuilt worker is left alone');
    host2.emit({
      type: 'done',
      id: b.id,
      segments: [{ start: 0, end: 1, text: 'ok' }],
      vadSegments: [],
    });
    assert.equal((await b.result).segments.length, 1);
  });

  await test('Windows + VAD 路径仍含非 ASCII（暂存失败回落原路径）：错误里带统一存储目录的建议', async () => {
    await withPlatform('win32', async () => {
      const runtime = freshRuntime(); // 暂存桩无映射 → 原路径
      const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
      const host = fixture.hosts[0];
      failVadOnWorker(host);
      host.emit({ type: 'done', id, segments: [], vadSegments: [] });
      const error = await rejection(result);
      assert.ok(
        error.message.includes('Unified Storage Directory'),
        error.message,
      );
    });
  });

  await test('Windows + VAD 已暂存到 ASCII 路径：原因不在路径上，不追加路径建议', async () => {
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      fixture.staged.set(CJK_VAD, ASCII_VAD);
      const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
      const host = fixture.hosts[0];
      assert.equal(host.lastRequest().vadModel, ASCII_VAD);
      failVadOnWorker(host);
      host.emit({ type: 'done', id, segments: [], vadSegments: [] });
      const error = await rejection(result);
      assert.equal(error.message.includes('Unified Storage Directory'), false);
      assert.ok(error.message.includes(REASON_TEXT));
    });
  });

  await test('worker 抛 `Please check your config!` 且模型路径含非 ASCII（Windows）：追加路径建议', async () => {
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      fixture.staged.set(CJK_VAD, ASCII_VAD);
      const { id, result } = runtime.transcribe(
        senseVoiceModel({ asrModel: CJK_ASR }),
        'a.wav',
      );
      fixture.hosts[0].emit({
        type: 'error',
        id,
        message: 'Error: Please check your config!',
      });
      const error = await rejection(result);
      assert.ok(
        error.message.startsWith('Error: Please check your config! '),
        error.message,
      );
      assert.ok(error.message.includes('Unified Storage Directory'));
    });
  });

  await test('嵌套的模型路径（qwen 四件套）也会被检查', async () => {
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      fixture.staged.set(CJK_VAD, ASCII_VAD);
      const { id, result } = runtime.transcribe(
        {
          vadModel: CJK_VAD,
          modelType: 'qwen3_asr',
          qwen: {
            convFrontend: 'D:\\models\\qwen\\conv.onnx',
            encoder: 'D:\\模型\\qwen\\encoder.onnx',
            decoder: 'D:\\models\\qwen\\decoder.onnx',
            tokenizer: 'D:\\models\\qwen\\tokenizer',
          },
          params: { provider: 'cpu', num_threads: 2 },
        },
        'a.wav',
      );
      fixture.hosts[0].emit({
        type: 'error',
        id,
        message: 'Error: Please check your config!',
      });
      const error = await rejection(result);
      assert.ok(error.message.includes('Unified Storage Directory'));
    });
  });

  await test('其他错误原样传递：ASCII 路径、非 Windows、取消、忙碌', async () => {
    // ASCII 路径（Windows）
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      fixture.staged.set(CJK_VAD, ASCII_VAD);
      const { id, result } = runtime.transcribe(senseVoiceModel(), 'a.wav');
      fixture.hosts[0].emit({
        type: 'error',
        id,
        message: 'Error: Please check your config!',
      });
      const error = await rejection(result);
      assert.equal(error.message, 'Error: Please check your config!');
    });
    // 非 Windows + 中文路径
    await withPlatform('darwin', async () => {
      const runtime = freshRuntime();
      const { id, result } = runtime.transcribe(
        senseVoiceModel({ asrModel: CJK_ASR }),
        'a.wav',
      );
      fixture.hosts[0].emit({
        type: 'error',
        id,
        message: 'Error: Please check your config!',
      });
      const error = await rejection(result);
      assert.equal(error.message, 'Error: Please check your config!');
    });
    // 取消保留 code
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      const { id, result } = runtime.transcribe(
        senseVoiceModel({ asrModel: CJK_ASR }),
        'a.wav',
      );
      fixture.hosts[0].emit({
        type: 'error',
        id,
        code: 'cancelled',
        message: 'cancelled',
      });
      const error = await rejection(result);
      assert.equal(error.message, 'cancelled');
      assert.equal(error.code, 'cancelled');
    });
  });

  await test('denoise：降噪模型路径含非 ASCII（暂存失败回落）时同样给出建议', async () => {
    await withPlatform('win32', async () => {
      const runtime = freshRuntime();
      const { id, result } = runtime.denoise('in.wav', CJK_VAD, 'out.wav');
      fixture.hosts[0].emit({
        type: 'error',
        id,
        message: 'Error: Please check your config!',
      });
      const error = await rejection(result);
      assert.ok(error.message.includes('Unified Storage Directory'));
    });
  });

  await test('denoise 成功不受影响（没有 VAD，也不做静默失败检查）', async () => {
    const runtime = freshRuntime();
    const { id, result } = runtime.denoise('in.wav', ASCII_VAD, 'out.wav');
    fixture.hosts[0].emit({
      type: 'done',
      id,
      segments: [],
      sampleRate: 16000,
    });
    await result;
  });

  console.log(
    `sherpa runtime: silent native failures surfaced (${passed} cases)`,
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
