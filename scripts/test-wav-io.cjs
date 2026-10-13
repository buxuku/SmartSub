'use strict';
/**
 * extraResources/sherpa/worker/wav-io.js 的单元测试（纯 Node，不需要原生库）。
 *
 * 背景：sherpa-onnx 的 readWave / writeWave 在 Windows 上用窄字符 API 打开文件，
 * 路径含非 ASCII（用户名是中文时默认 userData / %TEMP% 都是）且系统代码页不是
 * UTF-8 时会打不开（readWave 抛 `Failed to read`，writeWave 返回 false 且无人检查）。
 * wav-io.js 在这种路径上改由 JS 读写，其余路径仍走原生实现。
 *
 * 运行：node scripts/test-wav-io.cjs（已并入 yarn test:engines）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wavIo = require('../extraResources/sherpa/worker/wav-io.js');

let checks = 0;
function check(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const i16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
};
const tag = (s) => Buffer.from(s, 'latin1');

/** 一个 RIFF 子块；奇数长度按规范补 1 字节。 */
function chunk(id, body) {
  return Buffer.concat([
    tag(id),
    u32(body.length),
    body,
    body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

function fmtBody({
  format = 1,
  channels = 1,
  rate = 16000,
  bits = 16,
  extensible = false,
  subFormat = 1,
}) {
  const blockAlign = (channels * bits) / 8;
  const base = Buffer.concat([
    u16(extensible ? 0xfffe : format),
    u16(channels),
    u32(rate),
    u32(rate * blockAlign),
    u16(blockAlign),
    u16(bits),
  ]);
  if (!extensible) return base;
  return Buffer.concat([
    base,
    u16(22), // cbSize
    u16(bits), // valid bits
    u32(0x4), // channel mask
    u16(subFormat), // SubFormat GUID 的前两个字节就是格式码
    Buffer.from('000000001000800000aa00389b71', 'hex'),
  ]);
}

function riff(chunks) {
  const body = Buffer.concat([tag('WAVE'), ...chunks]);
  return Buffer.concat([tag('RIFF'), u32(body.length), body]);
}

function pcm16Wav(values, opts = {}) {
  return riff([
    ...(opts.before || []),
    chunk('fmt ', fmtBody({ channels: opts.channels || 1, ...opts.fmt })),
    chunk('data', Buffer.concat(values.map(i16))),
  ]);
}

const f32 = (values) => Float32Array.from(values);

// ---------------------------------------------------------------------------
// hasNonAscii / useJsWavIo：什么时候走 JS
// ---------------------------------------------------------------------------
check('hasNonAscii', () => {
  assert.equal(wavIo.hasNonAscii(''), false);
  assert.equal(wavIo.hasNonAscii('C:\\Users\\bob smith\\a.wav'), false);
  assert.equal(wavIo.hasNonAscii('C:\\Users\\张三\\a.wav'), true);
  assert.equal(wavIo.hasNonAscii('/tmp/José/a.wav'), true);
  assert.equal(wavIo.hasNonAscii('\u007f'), false);
  assert.equal(wavIo.hasNonAscii('\u0080'), true);
});

check('useJsWavIo: only win32 + non-ASCII, or the force switch', () => {
  const cjk = 'C:\\Users\\张三\\a.wav';
  const ascii = 'C:\\Users\\bob\\a.wav';
  assert.equal(wavIo.useJsWavIo(cjk, { platform: 'win32', env: {} }), true);
  assert.equal(wavIo.useJsWavIo(ascii, { platform: 'win32', env: {} }), false);
  assert.equal(wavIo.useJsWavIo(cjk, { platform: 'darwin', env: {} }), false);
  assert.equal(wavIo.useJsWavIo(cjk, { platform: 'linux', env: {} }), false);
  assert.equal(
    wavIo.useJsWavIo(ascii, {
      platform: 'darwin',
      env: { SMARTSUB_FORCE_JS_WAV: '1' },
    }),
    true,
    'the force switch exists so the JS path can be tested everywhere',
  );
  assert.equal(
    wavIo.useJsWavIo(ascii, {
      platform: 'darwin',
      env: { SMARTSUB_FORCE_JS_WAV: '0' },
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// encodeWavPcm16：与 sherpa-onnx 的 WriteWave 逐字节一致
// ---------------------------------------------------------------------------
check('encodeWavPcm16: fixed vector (header, scaling, clamping)', () => {
  const encoded = wavIo.encodeWavPcm16(
    f32([0, 0.5, -0.5, 1, -1, 2, -2]),
    16000,
  );
  const expected = Buffer.concat([
    tag('RIFF'),
    u32(36 + 14),
    tag('WAVE'),
    tag('fmt '),
    u32(16),
    u16(1), // PCM
    u16(1), // mono
    u32(16000),
    u32(32000), // byte rate
    u16(2), // block align
    u16(16),
    tag('data'),
    u32(14),
    // 乘 32767 后向零截断，再夹到 int16 范围：0.5 -> 16383，2 -> 32767，-2 -> -32768
    i16(0),
    i16(16383),
    i16(-16383),
    i16(32767),
    i16(-32767),
    i16(32767),
    i16(-32768),
  ]);
  assert.equal(Buffer.compare(encoded, expected), 0);
});

check('encodeWavPcm16: empty audio and NaN samples', () => {
  const empty = wavIo.encodeWavPcm16(new Float32Array(0), 8000);
  assert.equal(empty.length, 44);
  assert.equal(empty.readUInt32LE(40), 0);
  const withNaN = wavIo.encodeWavPcm16(f32([NaN, 0.25]), 16000);
  assert.equal(withNaN.readInt16LE(44), 0, 'NaN is written as silence');
  assert.equal(withNaN.readInt16LE(46), 8191);
});

check('encodeWavPcm16: rejects an invalid sample rate', () => {
  assert.throws(() => wavIo.encodeWavPcm16(f32([0]), 0), /sample rate/i);
  assert.throws(() => wavIo.encodeWavPcm16(f32([0]), NaN), /sample rate/i);
});

// ---------------------------------------------------------------------------
// decodeWav：与 sherpa-onnx 的 ReadWave 同口径（取第一声道，归一化到 [-1, 1)）
// ---------------------------------------------------------------------------
check('decodeWav: 16-bit PCM', () => {
  const decoded = wavIo.decodeWav(pcm16Wav([0, 16384, -16384, 32767, -32768]));
  assert.equal(decoded.sampleRate, 16000);
  assert.ok(decoded.samples instanceof Float32Array);
  assert.deepEqual(Array.from(decoded.samples), [
    0,
    0.5,
    -0.5,
    32767 / 32768,
    -1,
  ]);
});

check('decodeWav: 8-bit unsigned PCM', () => {
  const wav = riff([
    chunk('fmt ', fmtBody({ bits: 8 })),
    chunk('data', Buffer.from([0, 128, 255])),
  ]);
  assert.deepEqual(Array.from(wavIo.decodeWav(wav).samples), [
    -1,
    0,
    255 / 128 - 1,
  ]);
});

check('decodeWav: 32-bit PCM keeps the sign', () => {
  const body = Buffer.alloc(12);
  body.writeInt32LE(0, 0);
  body.writeInt32LE(2 ** 30, 4);
  body.writeInt32LE(-(2 ** 31), 8);
  const wav = riff([chunk('fmt ', fmtBody({ bits: 32 })), chunk('data', body)]);
  assert.deepEqual(Array.from(wavIo.decodeWav(wav).samples), [0, 0.5, -1]);
});

check('decodeWav: 32-bit float', () => {
  const body = Buffer.alloc(8);
  body.writeFloatLE(0.25, 0);
  body.writeFloatLE(-0.75, 4);
  const wav = riff([
    chunk('fmt ', fmtBody({ format: 3, bits: 32 })),
    chunk('data', body),
  ]);
  assert.deepEqual(Array.from(wavIo.decodeWav(wav).samples), [0.25, -0.75]);
});

check('decodeWav: stereo keeps the first channel only', () => {
  // L R L R ...
  const wav = pcm16Wav([16384, -16384, 8192, -8192], { channels: 2 });
  assert.deepEqual(Array.from(wavIo.decodeWav(wav).samples), [0.5, 0.25]);
});

check('decodeWav: skips JUNK / LIST chunks, honours the pad byte', () => {
  // fmt 之前一个 JUNK；data 之前一个奇数长度的 LIST（7 字节 + 1 字节补位）
  const wav = riff([
    chunk('JUNK', Buffer.alloc(28)),
    chunk('fmt ', fmtBody({})),
    chunk('LIST', Buffer.from('INFOabc')),
    chunk('data', Buffer.concat([i16(16384), i16(-16384)])),
  ]);
  assert.deepEqual(Array.from(wavIo.decodeWav(wav).samples), [0.5, -0.5]);
});

check('decodeWav: WAVE_FORMAT_EXTENSIBLE (PCM and float)', () => {
  const pcm = riff([
    chunk('fmt ', fmtBody({ extensible: true, subFormat: 1 })),
    chunk('data', Buffer.concat([i16(16384), i16(-16384)])),
  ]);
  assert.deepEqual(Array.from(wavIo.decodeWav(pcm).samples), [0.5, -0.5]);

  const floatBody = Buffer.alloc(4);
  floatBody.writeFloatLE(0.125);
  const flt = riff([
    chunk('fmt ', fmtBody({ extensible: true, subFormat: 3, bits: 32 })),
    chunk('data', floatBody),
  ]);
  assert.deepEqual(Array.from(wavIo.decodeWav(flt).samples), [0.125]);
});

check('decodeWav: a trailing partial frame is ignored', () => {
  const wav = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('data', Buffer.concat([i16(100), i16(200), i16(300)])), // 1.5 帧
  ]);
  assert.equal(wavIo.decodeWav(wav).samples.length, 1);
});

check('decodeWav: rejects bad input with a readable reason', () => {
  assert.throws(() => wavIo.decodeWav(Buffer.from('hello world!')), /RIFF/);
  assert.throws(() => wavIo.decodeWav(Buffer.alloc(4)), /RIFF/);
  const notWave = Buffer.concat([tag('RIFF'), u32(4), tag('AVI ')]);
  assert.throws(() => wavIo.decodeWav(notWave), /WAVE/);
  assert.throws(
    () => wavIo.decodeWav(riff([chunk('fmt ', fmtBody({}))])),
    /data/,
  );
  assert.throws(
    () => wavIo.decodeWav(riff([chunk('data', Buffer.alloc(4))])),
    /fmt/,
  );
  const truncated = pcm16Wav([1, 2, 3, 4]).subarray(0, 44 + 3);
  assert.throws(() => wavIo.decodeWav(truncated), /truncated/);
  const adpcm = riff([
    chunk('fmt ', fmtBody({ format: 2, bits: 4 })),
    chunk('data', Buffer.alloc(8)),
  ]);
  assert.throws(() => wavIo.decodeWav(adpcm), /unsupported/i);
  const bits24 = riff([
    chunk('fmt ', fmtBody({ bits: 24 })),
    chunk('data', Buffer.alloc(6)),
  ]);
  assert.throws(() => wavIo.decodeWav(bits24), /unsupported/i);
});

check('encode -> decode round trip stays within one quantisation step', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const samples = Float32Array.from({ length: 4000 }, () => rand() * 2 - 1);
  const decoded = wavIo.decodeWav(wavIo.encodeWavPcm16(samples, 22050));
  assert.equal(decoded.sampleRate, 22050);
  assert.equal(decoded.samples.length, samples.length);
  let worst = 0;
  for (let i = 0; i < samples.length; i += 1) {
    worst = Math.max(worst, Math.abs(decoded.samples[i] - samples[i]));
  }
  assert.ok(worst <= 2 / 32768, `worst error ${worst}`);
});

// ---------------------------------------------------------------------------
// readWave / writeWave：路径决定走 JS 还是原生
// ---------------------------------------------------------------------------
function fakeSherpa({ writeResult = true } = {}) {
  const calls = [];
  return {
    calls,
    readWave(file, external) {
      calls.push(['readWave', file, external]);
      return { samples: f32([0.5]), sampleRate: 16000 };
    },
    writeWave(file, wave) {
      calls.push(['writeWave', file, wave.sampleRate]);
      return writeResult;
    },
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-wav-io-'));
try {
  const win = { platform: 'win32', env: {} };
  const mac = { platform: 'darwin', env: {} };
  const cjkDir = path.join(tmpRoot, '中文用户-测试');
  fs.mkdirSync(cjkDir, { recursive: true });

  check('readWave: ASCII path -> native, arguments untouched', () => {
    const sherpa = fakeSherpa();
    const wave = wavIo.readWave(sherpa, 'C:\\Users\\bob\\a.wav', false, win);
    assert.deepEqual(sherpa.calls, [
      ['readWave', 'C:\\Users\\bob\\a.wav', false],
    ]);
    assert.equal(wave.sampleRate, 16000);
  });

  check('readWave: non-Windows + CJK path -> native', () => {
    const sherpa = fakeSherpa();
    wavIo.readWave(sherpa, '/Users/张三/a.wav', false, mac);
    assert.equal(sherpa.calls.length, 1);
  });

  check(
    'readWave / writeWave: CJK path on Windows -> JS, native untouched',
    () => {
      const sherpa = fakeSherpa();
      const file = path.join(cjkDir, 'round-trip.wav');
      const samples = f32([0, 0.25, -0.25, 0.75, -0.75]);
      wavIo.writeWave(sherpa, file, { samples, sampleRate: 24000 }, win);
      assert.ok(fs.existsSync(file), 'the file is written by JS');
      const back = wavIo.readWave(sherpa, file, false, win);
      assert.equal(back.sampleRate, 24000);
      assert.equal(back.samples.length, samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        assert.ok(Math.abs(back.samples[i] - samples[i]) <= 2 / 32768);
      }
      assert.deepEqual(sherpa.calls, [], 'the native library is not involved');
    },
  );

  check('SMARTSUB_FORCE_JS_WAV forces the JS path for ASCII paths', () => {
    const sherpa = fakeSherpa();
    const file = path.join(tmpRoot, 'forced.wav');
    const forced = { platform: 'darwin', env: { SMARTSUB_FORCE_JS_WAV: '1' } };
    wavIo.writeWave(
      sherpa,
      file,
      { samples: f32([0.5]), sampleRate: 16000 },
      forced,
    );
    assert.equal(wavIo.readWave(sherpa, file, false, forced).samples.length, 1);
    assert.deepEqual(sherpa.calls, []);
  });

  check(
    'readWave: JS failures keep the `Failed to read` prefix and the cause',
    () => {
      const sherpa = fakeSherpa();
      const missing = path.join(cjkDir, 'missing.wav');
      assert.throws(
        () => wavIo.readWave(sherpa, missing, false, win),
        (error) =>
          error.message.startsWith(`Failed to read '${missing}'`) &&
          /ENOENT/.test(error.message),
      );
      const garbage = path.join(cjkDir, 'garbage.wav');
      fs.writeFileSync(garbage, 'not a wav file at all');
      assert.throws(
        () => wavIo.readWave(sherpa, garbage, false, win),
        (error) =>
          error.message.startsWith(`Failed to read '${garbage}'`) &&
          /RIFF/.test(error.message),
      );
    },
  );

  check('writeWave: a failing JS write throws', () => {
    const sherpa = fakeSherpa();
    const unwritable = path.join(cjkDir, 'no-such-dir', 'out.wav');
    assert.throws(
      () =>
        wavIo.writeWave(
          sherpa,
          unwritable,
          { samples: f32([0]), sampleRate: 16000 },
          win,
        ),
      (error) => error.message.startsWith(`Failed to write '${unwritable}'`),
    );
  });

  check('writeWave: native `false` is no longer ignored', () => {
    const file = 'C:\\Users\\bob\\out.wav';
    const wave = { samples: f32([0]), sampleRate: 16000 };
    assert.throws(
      () =>
        wavIo.writeWave(fakeSherpa({ writeResult: false }), file, wave, win),
      (error) => error.message.startsWith(`Failed to write '${file}'`),
    );
    // true 与 undefined（旧版本 / 测试替身）都按成功处理
    assert.doesNotThrow(() =>
      wavIo.writeWave(fakeSherpa({ writeResult: true }), file, wave, win),
    );
    assert.doesNotThrow(() =>
      wavIo.writeWave(fakeSherpa({ writeResult: undefined }), file, wave, win),
    );
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`wav-io: ${checks} checks passed`);
