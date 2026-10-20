#!/usr/bin/env node
/**
 * 签名之后刷新 latest.yml 里的安装包校验值。
 *
 * 代码签名会改写安装包（追加签名数据），文件的 SHA-512 随之改变。
 * electron-updater 下载更新后，会拿 latest.yml 里的 sha512 校验文件，
 * 不一致就拒绝安装，所以每次签名之后都必须用「签名后的文件」重算。
 *
 * 用法：
 *   node scripts/refresh-update-checksum.mjs \
 *     --yml dist/latest.yml \
 *     --unsigned dist/SmartSub_Windows_3.10.2_x64.exe \
 *     --signed signed/SmartSub_Windows_3.10.2_x64.exe
 *
 * 出现下面任一情况都会以非 0 退出，宁可让发版失败，也不发布校验值错误的更新：
 *   - latest.yml 里找不到未签名安装包的 sha512（指错了文件）
 *   - 签名前后的文件内容完全相同（签名其实没有生效）
 *
 * 只做字符串替换，不解析再序列化 YAML，所以 latest.yml 里其它内容原样保留。
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * electron-updater 用的校验值：SHA-512 的 base64。
 * 同时返回字节数，兼容带 size 字段的 latest.yml。
 * 用流式读取，避免把上百 MB 的安装包整个读进内存。
 */
export async function fingerprint(file) {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha512: hash.digest('base64'), size };
}

/**
 * 把 yml 文本里「签名前」的校验值换成「签名后」的。
 * @param {string} text latest.yml 的内容
 * @param {{ sha512: string, size: number }} before 未签名安装包
 * @param {{ sha512: string, size: number }} after 已签名安装包
 * @returns {{ text: string, digestReplacements: number, sizeReplacements: number }}
 */
export function refreshYaml(text, before, after) {
  if (before.sha512 === after.sha512) {
    throw new Error(
      'The signed installer is byte-identical to the unsigned one, so signing did not change the file.',
    );
  }

  const parts = text.split(before.sha512);
  const digestReplacements = parts.length - 1;
  if (digestReplacements === 0) {
    throw new Error(
      'latest.yml does not contain the sha512 of the unsigned installer. Wrong yml or wrong installer?',
    );
  }

  // base64 里有 + / =，这里用 split/join 而不是正则，避免转义问题
  let next = parts.join(after.sha512);

  // 带差分更新时 latest.yml 会有 size 字段；没有就什么都不做
  let sizeReplacements = 0;
  const sizeLine = new RegExp(`^(\\s*size:\\s*)${before.size}(\\s*)$`, 'gm');
  next = next.replace(sizeLine, (_match, prefix, suffix) => {
    sizeReplacements += 1;
    return `${prefix}${after.size}${suffix}`;
  });

  return { text: next, digestReplacements, sizeReplacements };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Bad arguments near "${key ?? ''}"`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

async function main(argv) {
  const { yml, unsigned, signed } = parseArgs(argv);
  if (!yml || !unsigned || !signed) {
    throw new Error(
      'Usage: refresh-update-checksum.mjs --yml <latest.yml> --unsigned <installer> --signed <installer>',
    );
  }

  const [before, after] = await Promise.all([
    fingerprint(unsigned),
    fingerprint(signed),
  ]);
  const result = refreshYaml(readFileSync(yml, 'utf8'), before, after);
  writeFileSync(yml, result.text);

  // 写完再读一遍确认，确保没有残留旧值
  const written = readFileSync(yml, 'utf8');
  if (!written.includes(after.sha512) || written.includes(before.sha512)) {
    throw new Error(`Verification after writing ${yml} failed.`);
  }

  console.log(
    `Refreshed ${yml}: sha512 ${before.sha512.slice(0, 12)}... -> ${after.sha512.slice(0, 12)}... ` +
      `(${result.digestReplacements} digest, ${result.sizeReplacements} size), ` +
      `installer ${before.size} -> ${after.size} bytes`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
