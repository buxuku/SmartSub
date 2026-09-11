/**
 * 跨平台字符集探测与编码/解码工具模块
 *
 * 核心针对 Windows 历史遗留 ANSI (GBK/GB2312/GB18030)、Big5 以及带 BOM 的 UTF-8/UTF-16 字幕文件，
 * 提供确定性 BOM 嗅探、Node 原生 TextDecoder 致命模式校验以及无缝容错回退。
 */

import iconv from 'iconv-lite';
import type { EncodingDetectResult } from '../../../types/toolbox';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/**
 * 探测 Buffer 的文本编码
 */
export function detectBufferEncoding(buffer: Buffer): EncodingDetectResult {
  if (!buffer || buffer.length === 0) {
    return {
      encoding: 'UTF-8',
      hasBom: false,
      confidence: 1.0,
      sampleText: '',
    };
  }

  // 1. 检查已知 BOM 头
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    const text = buffer.subarray(3).toString('utf-8');
    return {
      encoding: 'UTF-8 with BOM',
      hasBom: true,
      confidence: 1.0,
      sampleText: text.slice(0, 200),
    };
  }

  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    try {
      const text = new TextDecoder('utf-16le').decode(buffer.subarray(2));
      return {
        encoding: 'UTF-16LE',
        hasBom: true,
        confidence: 1.0,
        sampleText: text.slice(0, 200),
      };
    } catch {
      // 继续向下尝试
    }
  }

  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    try {
      const text = new TextDecoder('utf-16be').decode(buffer.subarray(2));
      return {
        encoding: 'UTF-16BE',
        hasBom: true,
        confidence: 1.0,
        sampleText: text.slice(0, 200),
      };
    } catch {
      // 继续向下尝试
    }
  }

  // 2. 尝试无 BOM UTF-8（严格致命校验）
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    const text = utf8Decoder.decode(buffer);
    return {
      encoding: 'UTF-8',
      hasBom: false,
      confidence: 0.99,
      sampleText: text.slice(0, 200),
    };
  } catch {
    // 抛出 TypeError 说明包含非合法 UTF-8 字节序列（极大可能是 GBK / GB18030 / Big5）
  }

  // 3. 尝试 GB18030 (向下兼容 GBK 和 GB2312)
  try {
    const gbDecoder = new TextDecoder('gb18030', { fatal: true });
    const text = gbDecoder.decode(buffer);
    // 检查解码后文本是否包含常见 CJK 字符
    const hasChinese = /[\u4e00-\u9fa5]/.test(text);
    return {
      encoding: 'GB18030',
      hasBom: false,
      confidence: hasChinese ? 0.95 : 0.8,
      sampleText: text.slice(0, 200),
    };
  } catch {
    // 不是标准 GB18030
  }

  // 4. 尝试 Big5 (繁体中文)
  try {
    const big5Decoder = new TextDecoder('big5', { fatal: true });
    const text = big5Decoder.decode(buffer);
    return {
      encoding: 'Big5',
      hasBom: false,
      confidence: 0.85,
      sampleText: text.slice(0, 200),
    };
  } catch {
    // 不是 Big5
  }

  // 5. 最终兜底：非致命 UTF-8 容错解码
  const fallbackText = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return {
    encoding: 'UTF-8',
    hasBom: false,
    confidence: 0.5,
    sampleText: fallbackText.slice(0, 200),
  };
}

/**
 * 将 Buffer 解码为干净的字符串（自动去除 BOM 头，规整系统换行符）
 */
export function decodeBufferToString(
  buffer: Buffer,
  forcedEncoding?: string,
): { text: string; detectedEncoding: string } {
  const detect = detectBufferEncoding(buffer);
  const targetEncoding = (forcedEncoding && forcedEncoding !== 'auto')
    ? forcedEncoding.toLowerCase()
    : detect.encoding.toLowerCase();

  let raw = '';

  if (targetEncoding.includes('utf-8 with bom') || (targetEncoding.includes('utf-8') && detect.hasBom)) {
    raw = buffer.subarray(3).toString('utf-8');
  } else if (targetEncoding.includes('utf-16le')) {
    const offset = detect.hasBom ? 2 : 0;
    raw = new TextDecoder('utf-16le').decode(buffer.subarray(offset));
  } else if (targetEncoding.includes('utf-16be')) {
    const offset = detect.hasBom ? 2 : 0;
    raw = new TextDecoder('utf-16be').decode(buffer.subarray(offset));
  } else if (targetEncoding.includes('gb') || targetEncoding === 'ansi') {
    raw = iconv.decode(buffer, 'gb18030');
  } else if (targetEncoding.includes('big5')) {
    raw = iconv.decode(buffer, 'big5');
  } else {
    raw = buffer.toString('utf-8');
  }

  // 规整换行符为标准 \n
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    text: normalized,
    detectedEncoding: detect.encoding,
  };
}

/**
 * 将文本编码为目标字符集的 Buffer
 */
export function encodeStringToBuffer(
  text: string,
  targetEncoding: 'utf-8' | 'utf-8-bom' | 'gb18030' | 'big5' = 'utf-8',
): Buffer {
  // 规范换行符：在 Windows 下如果目标是 GB18030/ANSI，使用 \r\n，否则保持 \n
  const outputText = targetEncoding === 'gb18030'
    ? text.replace(/\r?\n/g, '\r\n')
    : text.replace(/\r\n/g, '\n');

  switch (targetEncoding) {
    case 'utf-8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(outputText, 'utf-8')]);
    case 'gb18030':
      return iconv.encode(outputText, 'gb18030');
    case 'big5':
      return iconv.encode(outputText, 'big5');
    case 'utf-8':
    default:
      return Buffer.from(outputText, 'utf-8');
  }
}
