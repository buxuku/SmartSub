'use strict';
// wav 读写（纯 JS，不经 webpack；被 sherpa / tts / 说话人分离 worker 共用）。
//
// 为什么需要：sherpa-onnx 的 readWave / writeWave 在 C++ 层用窄字符 API 打开文件。
// Windows 系统代码页不是 UTF-8（例如中文版默认的 GBK）时，路径里的中文会被按本地
// 代码页解码成另一个不存在的名字：readWave 抛 `Failed to read ...`，writeWave 返回
// false（原来没有任何调用方检查它，于是产物悄悄缺失）。用户名带中文时，默认
// userData、%TEMP%、安装目录都是这种路径。
//
// 做法：仅当「win32 且路径含非 ASCII」时改由 JS 读写（Node 的 fs 走宽字符 API，
// 不受代码页影响）；其余路径仍走原生实现，行为不变。writeWave 的失败从此是异常。
// 环境变量 SMARTSUB_FORCE_JS_WAV=1 可在任何平台强制走 JS（测试与排查用）。
//
// 编解码口径与 sherpa-onnx 的 wave-reader.cc / wave-writer.cc 保持一致：
//   - 读：取第一声道，8 位无符号 / 16 位 / 32 位整数 / 32 位浮点，归一化到 [-1, 1)；
//   - 写：单声道 16 位 PCM，按「float × 32767，向零截断，夹到 int16」量化。
// 读比原生多接受 WAVE_FORMAT_EXTENSIBLE（子格式为 PCM / 浮点），其余格式一律报错。
const fs = require('fs');

const NON_ASCII = /[^\x00-\x7F]/;

function hasNonAscii(value) {
  return NON_ASCII.test(value);
}

/** 这个路径是否应当绕开原生 readWave / writeWave。 */
function useJsWavIo(file, options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  if (env.SMARTSUB_FORCE_JS_WAV === '1') return true;
  return platform === 'win32' && hasNonAscii(String(file));
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function parseFormat(buf, offset, size) {
  if (size < 16) throw new Error('fmt chunk is too short');
  let format = buf.readUInt16LE(offset);
  const channels = buf.readUInt16LE(offset + 2);
  const sampleRate = buf.readUInt32LE(offset + 4);
  const bits = buf.readUInt16LE(offset + 14);
  if (format === FORMAT_EXTENSIBLE) {
    // cbSize(2) validBits(2) channelMask(4) SubFormat GUID(16)：GUID 的前两个字节是真正的格式码
    if (size < 40)
      throw new Error('WAVE_FORMAT_EXTENSIBLE fmt chunk is too short');
    format = buf.readUInt16LE(offset + 24);
  }
  if (channels < 1) throw new Error(`invalid channel count ${channels}`);
  if (sampleRate < 1) throw new Error(`invalid sample rate ${sampleRate}`);
  const supported =
    (format === FORMAT_PCM && (bits === 8 || bits === 16 || bits === 32)) ||
    (format === FORMAT_FLOAT && bits === 32);
  if (!supported) {
    throw new Error(
      `unsupported WAVE format ${format} with ${bits} bits per sample`,
    );
  }
  return { format, channels, sampleRate, bits };
}

/**
 * 解码 wav 字节，返回 { samples: Float32Array（第一声道）, sampleRate }。
 * 数据不合规时抛带原因的 Error。
 */
function decodeWav(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF') {
    throw new Error('not a RIFF file');
  }
  if (buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a WAVE file');
  }

  let fmt = null;
  let dataStart = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + size > buf.length) throw new Error('fmt chunk is truncated');
      fmt = parseFormat(buf, body, size);
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk found before the fmt chunk');
      dataStart = body;
      dataSize = size;
      break;
    }
    // RIFF 子块按偶数字节对齐，奇数长度后面有 1 字节补位
    pos = body + size + (size & 1);
  }
  if (!fmt) throw new Error('fmt chunk not found');
  if (dataStart < 0) throw new Error('data chunk not found');
  if (dataStart + dataSize > buf.length) {
    throw new Error(
      `data chunk is truncated (declared ${dataSize} bytes, ${
        buf.length - dataStart
      } available)`,
    );
  }

  const bytesPerSample = fmt.bits / 8;
  const frameSize = bytesPerSample * fmt.channels;
  const frames = Math.floor(dataSize / frameSize);
  const samples = new Float32Array(frames);
  const view = new DataView(buf.buffer, buf.byteOffset + dataStart, dataSize);
  for (let i = 0; i < frames; i += 1) {
    const at = i * frameSize;
    let value;
    if (fmt.format === FORMAT_FLOAT) value = view.getFloat32(at, true);
    else if (fmt.bits === 16) value = view.getInt16(at, true) / 32768;
    else if (fmt.bits === 8) value = view.getUint8(at) / 128 - 1;
    else value = view.getInt32(at, true) / 2147483648;
    samples[i] = value;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/** float → int16，与 sherpa-onnx WriteWave 相同：×32767（单精度）、向零截断、夹到 int16。 */
function quantize(sample) {
  const value = Math.trunc(Math.fround(sample * 32767));
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value || 0; // NaN -> 0
}

/** 编码为单声道 16 位 PCM wav（44 字节头），布局与 sherpa-onnx 的 WriteWave 逐字节一致。 */
function encodeWavPcm16(samples, sampleRate) {
  const rate = Number(sampleRate);
  if (!Number.isInteger(rate) || rate < 1) {
    throw new TypeError(`invalid sample rate ${sampleRate}`);
  }
  const dataBytes = samples.length * 2;
  if (dataBytes > 0xffffffff - 36) {
    throw new RangeError('audio is too long for a 32-bit RIFF container');
  }
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16); // fmt 块长度
  out.writeUInt16LE(FORMAT_PCM, 20);
  out.writeUInt16LE(1, 22); // 单声道
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(dataBytes, 40);
  const view = new DataView(out.buffer, out.byteOffset + 44, dataBytes);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, quantize(samples[i]), true);
  }
  return out;
}

function failure(verb, file, cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Failed to ${verb} '${file}': ${reason}`);
}

/**
 * 读 wav：非 ASCII 的 Windows 路径走 JS，其余调用 sherpa.readWave(file, enableExternalBuffer)。
 * 两条路径的返回值形状一致：{ samples: Float32Array, sampleRate }。
 */
function readWave(sherpa, file, enableExternalBuffer, options) {
  if (!useJsWavIo(file, options)) {
    return sherpa.readWave(file, enableExternalBuffer);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw failure('read', file, error);
  }
  try {
    return decodeWav(bytes);
  } catch (error) {
    throw failure('read', file, error);
  }
}

/**
 * 写 wav：非 ASCII 的 Windows 路径走 JS，其余调用 sherpa.writeWave(file, wave)。
 * 失败一律抛错——原生 writeWave 失败只返回 false，过去没有人检查，产物就悄悄缺失了。
 * 只有明确返回 false 才算失败（旧版本 / 测试替身可能返回 undefined）。
 */
function writeWave(sherpa, file, wave, options) {
  if (useJsWavIo(file, options)) {
    try {
      fs.writeFileSync(file, encodeWavPcm16(wave.samples, wave.sampleRate));
    } catch (error) {
      throw failure('write', file, error);
    }
    return;
  }
  if (sherpa.writeWave(file, wave) === false) {
    throw new Error(`Failed to write '${file}'`);
  }
}

module.exports = {
  hasNonAscii,
  useJsWavIo,
  decodeWav,
  encodeWavPcm16,
  readWave,
  writeWave,
};
