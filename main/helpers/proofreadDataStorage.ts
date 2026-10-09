/**
 * 校对 sidecar 的托管存储位置。
 *
 * 新生成的 sidecar 写入宿主注入的托管目录（应用侧 = userData/proofread-data），
 * 不再散落在用户视频旁的 .smartsub-proofread/。宿主未注入时回落旧的邻居目录，
 * 脚本与单测无需改动；存量 sidecar 继续按各自记录的绝对路径读写，不做迁移。
 *
 * 零 electron 依赖：被纯 node 编译运行的配音脚本（speakerMetadata）与单测共用。
 */

import path from 'path';

/** 旧版把 sidecar 放在视频目录旁的这个文件夹里；存量文件仍在其中，不会被自动清理。 */
export const LEGACY_PROOFREAD_DIR = '.smartsub-proofread';

let managedRoot: string | undefined;

/**
 * 宿主注入托管目录（应用启动时以 userData/proofread-data 调用）。
 * 传 undefined 复位为未注入状态，供单测隔离使用。
 */
export function setProofreadDataRoot(dir: string | undefined): void {
  managedRoot = dir ? path.resolve(dir) : undefined;
}

/** 当前托管目录；宿主未注入时为 undefined，此时 sidecar 回落到视频旁的旧目录 */
export function getProofreadDataRoot(): string | undefined {
  return managedRoot;
}
