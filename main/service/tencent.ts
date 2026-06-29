import crypto from 'crypto';
import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

const HOST = 'tmt.tencentcloudapi.com';
const ENDPOINT = `https://${HOST}`;
const SERVICE = 'tmt';
const VERSION = '2018-03-21';
const ACTION = 'TextTranslate';

function sha256hex(message: string): string {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * 生成腾讯云 API 3.0 TC3-HMAC-SHA256 鉴权头
 * 文档：https://cloud.tencent.com/document/product/551/30636
 */
function buildAuthHeaders(
  secretId: string,
  secretKey: string,
  region: string,
  payload: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';

  // 1. 拼接规范请求串
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = sha256hex(payload);
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  // 2. 拼接待签名字符串
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  // 3. 计算签名
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto
    .createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  // 4. 拼接 Authorization
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: HOST,
    'X-TC-Action': ACTION,
    'X-TC-Timestamp': timestamp.toString(),
    'X-TC-Version': VERSION,
    'X-TC-Region': region,
  };
}

/**
 * 腾讯云机器翻译（TMT）
 * 文档：https://cloud.tencent.com/document/product/551/15619
 * 使用 TextTranslate 单条接口（支持源语言 auto），逐条翻译返回等长数组，
 * 保证译文与时间轴一一对应。
 */
export default async function tencent(
  query: string | string[],
  proof: { apiKey?: string; apiSecret?: string; region?: string },
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const {
    apiKey: secretId,
    apiSecret: secretKey,
    region = 'ap-guangzhou',
  } = proof || {};
  if (!secretId || !secretKey) {
    console.log('请先配置腾讯云 SecretId 和 SecretKey');
    throw new Error('missingKeyOrSecret');
  }

  const source = convertLanguageCode(sourceLanguage, 'tencent') || 'auto';
  const target = convertLanguageCode(targetLanguage, 'tencent');
  if (!target) {
    console.log('不支持的语言');
    throw new Error('not supported language');
  }

  const translateOne = async (text: string): Promise<string> => {
    throwIfSignalCancelled(options?.signal);
    const payload = JSON.stringify({
      SourceText: text,
      Source: source,
      Target: target,
      ProjectId: 0,
    });
    const headers = buildAuthHeaders(secretId, secretKey, region, payload);
    const res = await axios.post(ENDPOINT, payload, {
      headers,
      timeout: TRANSLATION_REQUEST_TIMEOUT,
      signal: options?.signal,
    });
    throwIfSignalCancelled(options?.signal);
    const response = res?.data?.Response;
    if (!response || response.Error) {
      throw new Error(
        response?.Error?.Message ||
          response?.Error?.Code ||
          '腾讯云翻译返回错误',
      );
    }
    if (typeof response.TargetText !== 'string') {
      throw new Error('腾讯云翻译返回结果异常');
    }
    return response.TargetText;
  };

  if (Array.isArray(query)) {
    const results: string[] = [];
    for (const text of query) {
      results.push(await translateOne(text));
    }
    return results;
  }

  return translateOne(query);
}
